import { type App, type ButtonComponent, Notice, PluginSettingTab, Setting, type TextAreaComponent, type TextComponent } from "obsidian";
import type SeafilePlugin from "src/main";
import { debug } from "src/utils";
import { server } from "src/config";
import { getPasswordStore } from "src/password_store";
import { buildRepoConfigURI, writeRepoConfigFile, REPO_CONFIG_FILENAME } from "src/repo_config";
import qrcodeGen from "qrcode-generator";
import Dialog from "./dialog_modal";
import LoginModal from "./login_modal";
import PasswordModal from "./password_modal";
import RepoModal, { type SelectedRepo } from "./repo_modal";

export class SeafileSettingTab extends PluginSettingTab {
	constructor(public app: App, private readonly plugin: SeafilePlugin) {
		super(app, plugin);
	}

	display(): void {
		const settings = this.plugin.settings;
		const { containerEl } = this;
		containerEl.empty();

		let hostText: TextComponent;
		new Setting(containerEl)
			.setName("Host")
			.setDesc("Server URL. \"https://\" is assumed if left off.")
			.addText(text => {
				hostText = text;
				text.setPlaceholder("example.com");
				text.setValue(settings.host);
			})
			.addButton(button => button
				.setButtonText("Save")
				.onClick(async () => {
					try {
						const raw = hostText.getValue().trim();
						const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
						const url = new URL(withScheme);
						if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid protocol");
						settings.host = url.origin;
						await this.plugin.saveSettings();
						new Notice("Host saved");
					} catch (error) {
						new Notice((error as Error).message);
					}
					hostText.setValue(settings.host);
				})
			);

		// Declared here (before the Account/login UI below) so a successful
		// login can auto-complete repo binding when settings.repoId was already
		// pre-filled from a seasync.json file, without the user having to open
		// RepoModal and browse. Assigned once the Repository Setting row below
		// is actually created; safe because bindRepo is only ever invoked from
		// async callbacks that run after display() has finished executing.
		let repoSetting!: Setting;
		const repoDefaultDesc = "Choose a repository to sync.";
		const bindRepo = async ({ repoName, repoId, info }: SelectedRepo): Promise<void> => {
			const applyAndStart = async () => {
				settings.repoName = repoName;
				settings.repoId = repoId;
				settings.repoToken = info.token;
				settings.encrypted = info.encrypted;
				settings.encVersion = info.enc_version;
				settings.repoSalt = info.salt;
				settings.repoMagic = info.magic;
				settings.randomKey = info.random_key;
				repoSetting.setDesc(repoName);
				await this.plugin.saveSettings();
				if (settings.enableSync) this.plugin.sync.startSync();
			};

			if (info.encrypted) {
				if (info.enc_version !== 2 && info.enc_version !== 4) {
					new Notice(`Encryption version ${info.enc_version} is not supported. Only v2 and v4 work.`);
					return;
				}
				new PasswordModal(this.app, {
					repoId,
					encVersion: info.enc_version,
					repoSalt: info.salt,
					magic: info.magic,
					randomKey: info.random_key
				}, async (crypto, password, remember) => {
					server.crypto = crypto;
					if (remember) {
						try {
							await getPasswordStore(this.app).save(repoId, password);
						} catch (e) {
							new Notice("Could not save password: " + (e as Error).message);
							debug.error(e);
						}
					}
					await applyAndStart();
				}).open();
			} else {
				server.crypto = null;
				await applyAndStart();
			}
		};

		const accountDefaultDesc = "Not logged in.";
		let accountButton: ButtonComponent;
		const accountSetting = new Setting(containerEl)
			.setName("Account")
			.setDesc(settings.account ? settings.account : accountDefaultDesc)
			.addButton(button => {
				accountButton = button;
				if (settings.account) { button.setButtonText("Log out"); } else { button.setButtonText("Log in"); }

				button.onClick(async () => {
					if (settings.account) {
						// Log out
						const result = await this.askClearVault("To log out, you need to clear your vault first.\n\n");
						if (!result) return;

						const oldRepoId = settings.repoId;
						settings.account = "";
						settings.authToken = "";
						settings.deviceName = "";
						settings.deviceId = "";
						settings.repoName = "";
						settings.repoId = "";
						settings.repoToken = "";
						settings.encrypted = false;
						settings.encVersion = 0;
						settings.repoSalt = "";
						settings.repoMagic = "";
						settings.randomKey = "";
						server.crypto = null;
						if (oldRepoId) await getPasswordStore(this.app).clear(oldRepoId);
						await this.plugin.saveSettings();
						accountButton.setButtonText("Log in");
						accountSetting.setDesc(accountDefaultDesc);
						repoSetting.setDesc(repoDefaultDesc);
					} else {
						// Login
						new LoginModal(this.app, async (account, token, deviceName, deviceId) => {
							settings.account = account;
							settings.authToken = token;
							settings.deviceName = deviceName;
							settings.deviceId = deviceId;
							await this.plugin.saveSettings();

							accountButton.setButtonText("Log out");
							accountSetting.setDesc(account);

							// A seasync.json file already pre-filled which repo to use --
							// finish binding it now instead of making the user browse
							// and re-pick it from RepoModal.
							if (settings.repoId && !settings.repoToken) {
								try {
									const info = await server.getRepoDownloadInfo(settings.repoId);
									await bindRepo({ repoName: settings.repoName || settings.repoId, repoId: settings.repoId, info });
								} catch (e) {
									new Notice(`Could not auto-configure the repo from ${REPO_CONFIG_FILENAME}: ` + (e as Error).message + ". Choose it manually below.");
									debug.error(e);
								}
							}
						}).open();
					}
				});
			});

		repoSetting = new Setting(containerEl)
			.setName("Repository")
			.setDesc(settings.repoName ? settings.repoName : repoDefaultDesc)
			.addButton(button => {
				button.setButtonText("Choose");
				button.onClick(async () => {
					if (!settings.authToken) {
						new Notice("Log in first before choosing a repository");
						return;
					}
					if (settings.repoToken) {
						const result = await this.askClearVault("To change repository, you need to clear your vault first.\n\n");
						if (!result) return;

						const oldRepoId = settings.repoId;
						settings.repoName = "";
						settings.repoId = "";
						settings.repoToken = "";
						settings.encrypted = false;
						settings.encVersion = 0;
						settings.repoSalt = "";
						settings.repoMagic = "";
						settings.randomKey = "";
						server.crypto = null;
						if (oldRepoId) await getPasswordStore(this.app).clear(oldRepoId);
						repoSetting.setDesc(repoDefaultDesc);
						await this.plugin.saveSettings();
					}
					new RepoModal(this.app, bindRepo).open();
				});
			});

		new Setting(containerEl)
			.setName("Repo config file")
			.setDesc(`Write ${REPO_CONFIG_FILENAME} to the vault so a new device/vault pointed at this vault's files can skip re-entering the server and repo (login is still required). Contains no credentials.`)
			.addButton(button => button
				.setButtonText("Export")
				.onClick(async () => {
					if (!settings.repoId) {
						new Notice("Choose a repository first");
						return;
					}
					try {
						await writeRepoConfigFile(this.app.vault.adapter, settings);
						new Notice(`Wrote ${REPO_CONFIG_FILENAME}`);
					} catch (e) {
						new Notice(`Failed to write ${REPO_CONFIG_FILENAME}: ` + (e as Error).message);
						debug.error(e);
					}
				})
			);

		let qrButton: ButtonComponent;
		new Setting(containerEl)
			.setName("Setup link")
			.setDesc("Same info as the repo config file, as an obsidian:// link -- scan the QR code (or open the link) on another device to pre-fill the server and repo. No credentials; login is still required.")
			.addButton(button => button
				.setButtonText("Copy link")
				.onClick(async () => {
					if (!settings.repoId) {
						new Notice("Choose a repository first");
						return;
					}
					await navigator.clipboard.writeText(buildRepoConfigURI(settings));
					new Notice("Setup link copied");
				})
			)
			.addButton(button => {
				qrButton = button;
				button.setButtonText("Show QR code")
					.onClick(() => {
						if (!settings.repoId) {
							new Notice("Choose a repository first");
							return;
						}
						const showing = qrContainer.style.display !== "none";
						if (showing) {
							qrContainer.style.display = "none";
							qrButton.setButtonText("Show QR code");
							return;
						}
						qrContainer.empty();
						const qr = qrcodeGen(0, "M");
						qr.addData(buildRepoConfigURI(settings));
						qr.make();
						qrContainer.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
						qrContainer.style.display = "";
						qrButton.setButtonText("Hide QR code");
					});
			});

		const qrContainer = containerEl.createDiv();
		qrContainer.style.display = "none";
		qrContainer.style.padding = "0.5em 0";

		if (settings.encrypted && settings.repoId) {
			const store = getPasswordStore(this.app);
			const savedPasswordSetting = new Setting(containerEl)
				.setName("Saved password")
				.setDesc("Checking...");

			let forgetBtn!: ButtonComponent;
			savedPasswordSetting.addButton(button => {
				forgetBtn = button;
				button.setButtonText("Forget").setDisabled(true);
				button.onClick(async () => {
					button.setDisabled(true);
					await store.clear(settings.repoId);
					savedPasswordSetting.setDesc("No password saved on this device.");
					new Notice("Saved password cleared");
				});
			});

			void (async () => {
				const stored = await store.load(settings.repoId);
				if (stored) {
					savedPasswordSetting.setDesc(`Saved. ${store.description}`);
					forgetBtn.setDisabled(false);
				} else {
					savedPasswordSetting.setDesc("No password saved on this device.");
				}
			})();
		}

		let enableSyncButton: ButtonComponent;
		const enableSyncSetting = new Setting(containerEl)
			.setName("Sync status")
			.setDesc(settings.enableSync ? "Enabled" : "Disabled")
			.addButton(button => {
				enableSyncButton = button;
				button.setButtonText(settings.enableSync ? "Disable" : "Enable");
				button.onClick(async () => {
					button.setDisabled(true);
					try {
						if (settings.enableSync) {
							// Disable sync
							await this.plugin.disableSync();
							new Notice("Sync disabled");
							button.setButtonText("Enable");
							enableSyncSetting.setDesc("Disabled");
						} else {
							// Enable sync
							if (this.plugin.checkSyncReady()) {
								await this.plugin.enableSync();
								new Notice("Sync enabled");
								button.setButtonText("Disable");
								enableSyncSetting.setDesc("Enabled");
							} else {
								if (settings.authToken) {
									if (!settings.repoToken) {
										new Notice("Choose a repository first before enabling sync");
									} else {
										new Notice("Sync is not ready");
									}
								} else {
									new Notice("Log in first before enabling sync");
								}
							}
						}
					} catch (error) {
						new Notice("Failed to change sync state: " + (error as Error).message);
						debug.error(error);
					} finally {
						button.setDisabled(false);
					}
				});
			});

		new Setting(containerEl)
			.setName("Manual sync")
			.setDesc("Trigger a sync immediately.")
			.addButton(button => button
				.setButtonText("Sync now")
				.onClick(async () => {
					button.setDisabled(true);
					try {
						await this.plugin.triggerManualSync();
					} finally {
						button.setDisabled(false);
					}
				})
			);

		let intervalText: TextComponent;
		new Setting(containerEl)
			.setName("Sync interval")
			.setDesc("in seconds.")
			.addText(text => {
				intervalText = text;
				text.setPlaceholder("30");
				text.setValue(Math.floor(settings.interval / 1000).toString());
			})
			.addButton(button => button
				.setButtonText("Save")
				.onClick(async () => {
					const seconds = parseInt(intervalText.getValue());
					if (isNaN(seconds) || seconds < 5) {
						new Notice("Sync interval must be at least 5 seconds");
					} else {
						settings.interval = seconds * 1000;
						await this.plugin.saveSettings();
						if (this.plugin.sync.status.type === "idle") { this.plugin.sync.startSync(); }
						new Notice("Sync interval saved");
					}
					intervalText.setValue(Math.floor(settings.interval / 1000).toString());
				})
			);

		let ignoreText: TextAreaComponent;
		new Setting(containerEl)
			.setName("Ignore")
			.setDesc("Use gitignore syntax.")
			.addTextArea(text => {
				ignoreText = text;
				text.setValue(settings.ignore);
			})
			.addButton(button => button
				.setButtonText("Save")
				.onClick(async () => {
					button.setDisabled(true);
					settings.ignore = ignoreText.getValue();
					this.plugin.sync.setIgnorePattern(settings.ignore);
					await this.plugin.saveSettings();
					new Notice("Ignore pattern saved");
					button.setDisabled(false);
				}));

		new Setting(containerEl)
			.setName("Dev mode")
			.setDesc("Enable development mode. Need restart to take effect.")
			.addToggle(toggle => toggle
				.setValue(settings.devMode)
				.onChange(async (value) => {
					settings.devMode = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Use fetch")
			.setDesc("Use fetch instead of Obsidian API. Need CORS enabled on the server.")
			.addToggle(toggle => toggle
				.setValue(settings.useFetch)
				.onChange(async (value) => {
					settings.useFetch = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Clear vault")
			.setDesc("Delete all local files and data. Try this if you encounter any issues.")
			.addButton(button => button
				.setButtonText("Clear")
				.setDestructive()
				.onClick(async () => {
					const success = await this.askClearVault();
					if (success) {
						// Sync has been disabled, update the UI
						enableSyncSetting.setDesc("Disabled");
						enableSyncButton.setButtonText("Enable");
					}
				})
			);
	}

	private async askClearVault(info: string = ""): Promise<boolean> {
		return await new Promise<boolean>((resolve) => {
			new Dialog(this.app,
				"Clear vault",
				info + "Are you sure you want to remove all local files and data? This action cannot be undone. \n\nThis will not delete any files that are in the ignore list.",
				async () => {
					try {
						await this.plugin.clearVault();
					} catch (error) {
						new Notice(`Failed to clear vault: ${(error as Error).message}`);
						debug.error(error);
					}
					resolve(true);
				},
				async () => {
					resolve(false);
				}
			).open();
		});
	}
}
