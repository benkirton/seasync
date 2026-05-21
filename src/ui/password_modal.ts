import { App, Modal, Notice, Setting, type ButtonComponent } from "obsidian";
import { RepoCrypto, type RepoCryptoMetadata, WrongPasswordError } from "../crypto";
import { getPasswordStore } from "../password_store";
import { debug } from "../utils";

export type PasswordCallback = (crypto: RepoCrypto, password: string, remember: boolean) => Promise<void> | void;

export default class PasswordModal extends Modal {
	private password = "";
	private remember = false;
	private submitBtn: ButtonComponent | null = null;

	constructor (app: App,
        private readonly meta: RepoCryptoMetadata,
        private readonly callback: PasswordCallback,
        private readonly onCancel?: () => void) {
		super(app);
	}

	onOpen (): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.textContent = "Unlock encrypted repository";
		contentEl.createEl("p", {
			text: "Enter the repository password."
		});

		new Setting(contentEl)
			.setName("Password")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("password");
				text.onChange(v => {
					this.password = v;
					this.submitBtn?.setDisabled(!v);
				});
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter" && this.password) void this.submit();
				});
			});

		const store = getPasswordStore();
		new Setting(contentEl)
			.setName("Remember on this device")
			.setDesc(store.description)
			.addToggle(toggle => {
				toggle.setValue(this.remember);
				toggle.onChange(v => { this.remember = v; });
			});

		new Setting(contentEl)
			.addButton(btn => {
				this.submitBtn = btn;
				btn.setButtonText("Unlock").setDisabled(true);
				btn.onClick(() => void this.submit());
			})
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()));
	}

	private cancelled = true;
	private async submit (): Promise<void> {
		if (!this.password) return;
		this.submitBtn?.setDisabled(true);
		try {
			const crypto = await RepoCrypto.unlock(this.meta, this.password);
			this.cancelled = false;
			await this.callback(crypto, this.password, this.remember);
			this.close();
		} catch (e) {
			if (e instanceof WrongPasswordError) {
				new Notice("Incorrect password");
			} else {
				new Notice("Unlock failed: " + (e as Error).message);
				debug.error(e);
			}
			this.submitBtn?.setDisabled(false);
		}
	}

	onClose (): void {
		this.password = "";
		if (this.cancelled) this.onCancel?.();
	}
}
