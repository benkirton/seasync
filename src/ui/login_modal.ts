import { App, arrayBufferToHex, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import { server } from "src/config";
import { MfaRequiredError } from "src/server";
import { debug } from "src/utils";

export type LoginCallback = (account: string, token: string, deviceName: string, deviceId: string) => void | Promise<void>;

export default class LoginModal extends Modal {
	private deviceName: string = "SeaSync";
	private otpToken: string = "";
	private otpTextComponent: TextComponent | null = null;
	private mfaRequired: boolean = false;
	private otpSetting: Setting | null = null;
	private loginButton: ButtonComponent | null = null;

	constructor(app: App,
        private callback: LoginCallback,
        private account?: string, private password?: string) {
		super(app);
	}

	private updateLoginButtonState(): void {
		if (!this.loginButton) return;
		const ready = !!(this.account && this.password && this.deviceName);
		const mfaReady = !this.mfaRequired || !!this.otpToken;
		this.loginButton.setDisabled(!(ready && mfaReady));
	}

	private showMfaField(): void {
		if (!this.otpSetting) return;
		this.otpSetting.settingEl.show();
		const input = this.otpSetting.settingEl.querySelector("input");
		if (input) input.focus();
		this.updateLoginButtonState();
	}

	async login(account: string, password: string, deviceName: string, otpToken?: string): Promise<string> {
		const notice = new Notice("Log in to Seafile...");
		try {
			const deviceIdBuffer = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(deviceName));
			const deviceId = arrayBufferToHex(deviceIdBuffer);

			const authToken = await server.getAuthToken(account, password, deviceName, deviceId, otpToken);
			if (!authToken) throw new Error("Failed to get auth token");

			await this.callback(account, authToken, deviceName, deviceId);

			return authToken;
		}
		finally {
			notice.hide();
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.textContent = "Login to Seafile";

		new Setting(contentEl)
			.setName("Device name")
			.addText(text => {
				text.setPlaceholder(this.deviceName);
				text.onChange(value => {
					this.deviceName = value;
					this.updateLoginButtonState();
				});
			});
		new Setting(contentEl)
			.setName("Account")
			.addText(text => text.setPlaceholder("email@example.com").onChange(value => {
				this.account = value;
				this.updateLoginButtonState();
			}));
		new Setting(contentEl)
			.setName("Password")
			.addText(password => {
				password.inputEl.type = "password";
				password.setPlaceholder("password")
					.onChange(value => {
						this.password = value;
						this.updateLoginButtonState();
					});
			});

		this.otpSetting = new Setting(contentEl)
			.setName("Two-factor auth token")
			.setDesc("Enter the code from your authenticator app")
			.addText(text => {
				this.otpTextComponent = text;
				text.setPlaceholder("123456")
					.onChange(value => {
						this.otpToken = value;
						this.updateLoginButtonState();
					});
				text.inputEl.autocomplete = "one-time-code";
			});
		this.otpSetting.settingEl.hide();

		new Setting(contentEl)
			.addButton(button => {
				this.loginButton = button;
				button.setButtonText("Log in");
				button.onClick(async () => {
					if (!this.account || !this.password || !this.deviceName) return;
					try {
						const otpValue = this.mfaRequired
							? (this.otpTextComponent?.getValue() || this.otpToken)
							: undefined;
						const result = await this.login(
							this.account,
							this.password,
							this.deviceName,
							otpValue
						);
						if (result) this.close();
					}
					catch (error) {
						if (error instanceof MfaRequiredError) {
							if (this.mfaRequired) {
								new Notice("Incorrect OTP code. Please try again.");
							} else {
								this.mfaRequired = true;
								this.showMfaField();
								new Notice("Two-factor authentication required. Please enter your OTP.");
							}
						} else {
							new Notice("Login failed: " + (error as Error).message);
							debug.error(error);
						}
					}
				});
			})
			.addButton(button => button.setButtonText("Log in with SSO")
				.onClick(() => { void this.loginWithSSO(); }))
			.addButton(button => button.setButtonText("Cancel")
				.onClick(() => this.close()));
	}

	// Browser-based SSO login. Opens the Seafile client-SSO link in the system
	// browser and polls until the user completes authentication, then reuses the
	// same callback as password login.
	private async loginWithSSO(): Promise<void> {
		if (!this.deviceName) {
			new Notice("Enter a device name first.");
			return;
		}

		const notice = new Notice("Starting SSO login...", 0);
		try {
			const deviceIdBuffer = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(this.deviceName));
			const deviceId = arrayBufferToHex(deviceIdBuffer);

			const { link, token } = await server.createClientSSOLink(this.deviceName, deviceId);
			window.open(link, "_blank");
			notice.setMessage("Complete the login in your browser, then return to Obsidian...");

			// Poll for up to ~5 minutes (150 attempts, 2s apart). A single transient
			// network error on one poll (dropped connection, brief server hiccup)
			// shouldn't abort the whole login attempt -- only give up after several
			// in a row.
			const maxConsecutivePollFailures = 5;
			let consecutivePollFailures = 0;
			for (let attempt = 0; attempt < 150; attempt++) {
				await sleep(2000);

				let result;
				try {
					result = await server.pollClientSSOLink(token);
					consecutivePollFailures = 0;
				} catch (error) {
					consecutivePollFailures++;
					if (consecutivePollFailures >= maxConsecutivePollFailures) throw error;
					debug.warn(`SSO poll attempt failed, retrying (${consecutivePollFailures}/${maxConsecutivePollFailures})`, error);
					continue;
				}

				if (result.apiToken) {
					await this.callback(result.username ?? "", result.apiToken, this.deviceName, deviceId);
					notice.hide();
					new Notice("Logged in via SSO.");
					this.close();
					return;
				}
				if (result.status && result.status.toLowerCase().includes("error")) {
					throw new Error("SSO login failed or expired on the server.");
				}
			}
			throw new Error("SSO login timed out.");
		} catch (error) {
			notice.hide();
			new Notice("SSO login failed: " + (error as Error).message);
			debug.error(error);
		}
	}
}