import { App, Modal, Notice, Setting } from "obsidian";
import { server } from "src/config";
import { Repo, type RepoDownloadInfo } from "src/server";
import { debug } from "src/utils";
import prettyBytes from "pretty-bytes";

export interface SelectedRepo {
  repoName: string
  repoId: string
  info: RepoDownloadInfo
}

export default class RepoModal extends Modal {

	constructor(app: App, private callback: (selected: SelectedRepo) => void | Promise<void>) {
		super(app);
	}

	async loadRepoToken(repo: Repo) {
		try {
			const info = await server.getRepoDownloadInfo(repo.repo_id);
			await this.callback({ repoName: repo.repo_name, repoId: repo.repo_id, info });
		}
		catch (error) {
			new Notice("Failed to load repository token. " + (error as Error).message);
			debug.error(error);
		}
	}

	async loadRepos(contentEl: HTMLElement) {
		const repoList = await server.getRepoList();

		for (const repo of repoList) {
			new Setting(contentEl)
				.setName(repo.repo_name)
				.setDesc(`Size: ${prettyBytes(repo.size)}. Last modified: ${new Date(repo.last_modified).toLocaleString()}.`)
				.addButton(button => button.onClick(async () => {
					button.setDisabled(true);
					await this.loadRepoToken(repo);
					this.close();
				}).setButtonText("Select"));
		}

		if (repoList.length == 0) {
			contentEl.createEl("p", { text: "No repositories found." });
		}
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.textContent = "Choose a repository to sync";

		const loading = contentEl.createEl("p", { text: "Loading repositories..." });
		this.loadRepos(contentEl).then(() => loading.remove()).catch(error => {
			loading.textContent = "Failed to load repositories. " + (error as Error).message;
			debug.error(error);
		});
	}
}