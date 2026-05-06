// Seafile client-side encryption (enc_version 2 and 4 only).
// Algorithm reference: haiwen/seafile common/seafile-crypt.c.
//
// v2: fixed 8-byte salt baked into the protocol.
// v4: per-repo random 32-byte salt (hex-encoded on the wire).
// Both use PBKDF2-HMAC-SHA256 + AES-256-CBC (PKCS7).

const FIXED_SALT_V2 = new Uint8Array([0xda, 0x90, 0x45, 0xc3, 0x06, 0xc7, 0xcc, 0x26]);

export class UnsupportedEncVersionError extends Error {
	constructor (version: number) {
		super(`Unsupported encryption version ${version}. Only v2 and v4 are supported.`);
	}
}

export class WrongPasswordError extends Error {
	constructor () { super("Incorrect repository password."); }
}

function hexToBytes (hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

function bytesToHex (bytes: Uint8Array | ArrayBuffer): string {
	const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, "0");
	return s;
}

function timingSafeEqualHex (a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function saltForVersion (version: number, repoSalt: string): Uint8Array {
	if (version === 2) return FIXED_SALT_V2;
	if (version === 4) {
		if (!repoSalt) throw new Error("v4 encryption requires repo_salt");
		return hexToBytes(repoSalt);
	}
	throw new UnsupportedEncVersionError(version);
}

async function pbkdf2 (data: Uint8Array, salt: Uint8Array, iterations: number, bits: number): Promise<Uint8Array> {
	const baseKey = await crypto.subtle.importKey("raw", data, { name: "PBKDF2" }, false, ["deriveBits"]);
	const derived = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
		baseKey,
		bits
	);
	return new Uint8Array(derived);
}

// Two-step derivation matches seafile_derive_key for v >= 2:
//   key = PBKDF2(data, salt, 1000, 32 bytes)
//   iv  = PBKDF2(key,  salt, 10,   16 bytes)
async function deriveKeyIv (data: Uint8Array, version: number, repoSalt: string): Promise<{ key: Uint8Array, iv: Uint8Array }> {
	const salt = saltForVersion(version, repoSalt);
	const key = await pbkdf2(data, salt, 1000, 32 * 8);
	const iv = await pbkdf2(key, salt, 10, 16 * 8);
	return { key, iv };
}

// magic = hex(first 32 bytes of key derived from `repo_id + password`).
export async function computeMagic (repoId: string, password: string, version: number, repoSalt: string): Promise<string> {
	const data = new TextEncoder().encode(repoId + password);
	const { key } = await deriveKeyIv(data, version, repoSalt);
	return bytesToHex(key);
}

export async function verifyPassword (repoId: string, password: string, version: number, repoSalt: string, magic: string): Promise<boolean> {
	const computed = await computeMagic(repoId, password, version, repoSalt);
	return timingSafeEqualHex(computed, magic);
}

async function aesCbcDecrypt (key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const k = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
	const out = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, k, data);
	return new Uint8Array(out);
}

async function aesCbcEncrypt (key: Uint8Array, iv: Uint8Array, data: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
	const k = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
	const out = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, k, data);
	return new Uint8Array(out);
}

// Unwrap the random_key (48 hex bytes wrapped) using the password-derived key/iv,
// then derive the actual block-encryption (encKey, encIV) from the unwrapped 32-byte secret.
async function deriveBlockKeys (password: string, randomKeyHex: string, version: number, repoSalt: string): Promise<{ encKey: Uint8Array, encIv: Uint8Array }> {
	const passData = new TextEncoder().encode(password);
	const { key: pwKey, iv: pwIv } = await deriveKeyIv(passData, version, repoSalt);

	const wrapped = hexToBytes(randomKeyHex);
	if (wrapped.length !== 48) throw new Error(`Unexpected random_key length ${wrapped.length}, expected 48`);

	let secret: Uint8Array;
	try {
		secret = await aesCbcDecrypt(pwKey, pwIv, wrapped);
	} catch {
		throw new WrongPasswordError();
	}
	if (secret.length !== 32) throw new Error(`Unwrapped secret has length ${secret.length}, expected 32`);

	const { key: encKey, iv: encIv } = await deriveKeyIv(secret, version, repoSalt);
	return { encKey, encIv };
}

export interface RepoCryptoMetadata {
  encVersion: number
  repoSalt: string
  magic: string
  randomKey: string
  repoId: string
}

export class RepoCrypto {
	private encKey?: Uint8Array;
	private encIv?: Uint8Array;

	private constructor (public readonly meta: RepoCryptoMetadata) {
		if (meta.encVersion !== 2 && meta.encVersion !== 4) {
			throw new UnsupportedEncVersionError(meta.encVersion);
		}
	}

	static async unlock (meta: RepoCryptoMetadata, password: string): Promise<RepoCrypto> {
		const ok = await verifyPassword(meta.repoId, password, meta.encVersion, meta.repoSalt, meta.magic);
		if (!ok) throw new WrongPasswordError();

		const { encKey, encIv } = await deriveBlockKeys(password, meta.randomKey, meta.encVersion, meta.repoSalt);
		const c = new RepoCrypto(meta);
		c.encKey = encKey;
		c.encIv = encIv;
		return c;
	}

	get isUnlocked (): boolean { return !!(this.encKey && this.encIv); }

	async encryptBlock (plaintext: ArrayBuffer): Promise<ArrayBuffer> {
		if (!this.encKey || !this.encIv) throw new Error("RepoCrypto not unlocked");
		const out = await aesCbcEncrypt(this.encKey, this.encIv, plaintext);
		return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
	}

	async decryptBlock (ciphertext: ArrayBuffer): Promise<ArrayBuffer> {
		if (!this.encKey || !this.encIv) throw new Error("RepoCrypto not unlocked");
		const out = await aesCbcDecrypt(this.encKey, this.encIv, new Uint8Array(ciphertext));
		return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
	}
}
