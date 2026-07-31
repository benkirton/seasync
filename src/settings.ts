export interface SeafileSettings {
  host: string
  account: string
  authToken: string
  repoName: string
  repoId: string
  repoToken: string
  deviceName: string
  deviceId: string
  interval: number
  ignore: string
  devMode: boolean
  enableSync: boolean
  useFetch: boolean

  // Encryption metadata (public, server-supplied). Password is never persisted.
  encrypted: boolean
  encVersion: number
  repoSalt: string
  repoMagic: string
  randomKey: string
}

export const DEFAULT_SETTINGS: SeafileSettings = {
	host: "",
	account: "",
	authToken: "",
	repoName: "",
	repoId: "",
	repoToken: "",
	deviceName: "seasync",
	deviceId: "",
	interval: 30000,
	ignore: "",
	devMode: false,
	enableSync: false,
	useFetch: false,
	encrypted: false,
	encVersion: 0,
	repoSalt: "",
	repoMagic: "",
	randomKey: "",
};
