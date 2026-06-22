import { App, PluginSettingTab, Setting } from "obsidian";
import type CalloutGraphPlugin from "./main";

export class CalloutGraphSettingTab extends PluginSettingTab {
	private plugin: CalloutGraphPlugin;

	constructor(app: App, plugin: CalloutGraphPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Trigger string")
			.setDesc('Type this in the editor to open the callout reference suggester (default ";;"). Avoid "@" — latex-suite uses it for Greek letters.')
			.addText((t) =>
				t.setValue(this.plugin.settings.triggerString).onChange(async (v) => {
					this.plugin.settings.triggerString = v || ";;";
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Long-filename threshold")
			.setDesc("Cross-note references to files whose name exceeds this length use the alias form [[name#^id|alias^id]].")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.longNameThreshold)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) {
						this.plugin.settings.longNameThreshold = n;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Citation ranking weight")
			.setDesc("How strongly the reference suggester favors heavily-cited callouts (0 disables).")
			.addSlider((s) =>
				s
					.setLimits(0, 2, 0.1)
					.setValue(this.plugin.settings.inDegreeWeight)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.inDegreeWeight = v;
						await this.plugin.saveSettings();
					}),
			);
	}
}
