import {
  PluginSettingTab,
  App,
  Setting,
  TextComponent,
  Modal,
  Notice,
} from "obsidian";
import GitHubSyncPlugin from "src/main";
import { MEDIA_EXTENSIONS, RELEASE_EXTENSIONS } from "src/settings/settings";
import { copyToClipboard } from "src/utils";

export default class GitHubSyncSettingsTab extends PluginSettingTab {
  plugin: GitHubSyncPlugin;

  constructor(app: App, plugin: GitHubSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl).setName("Remote Repository").setHeading();

    let tokenInput: TextComponent;
    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc(
        "A personal access token or a fine-grained token with read and write access to your repository",
      )
      .addButton((button) =>
        button.setIcon("eye-off").onClick((e) => {
          if (tokenInput.inputEl.type === "password") {
            tokenInput.inputEl.type = "text";
            button.setIcon("eye");
          } else {
            tokenInput.inputEl.type = "password";
            button.setIcon("eye-off");
          }
        }),
      )
      .addText((text) => {
        text
          .setPlaceholder("Token")
          .setValue(this.plugin.settings.githubToken)
          .onChange(async (value) => {
            this.plugin.settings.githubToken = value;
            await this.plugin.saveSettings();
          }).inputEl.type = "password";
        tokenInput = text;
      });

    new Setting(containerEl)
      .setName("Owner")
      .setDesc("Owner of the repository to sync")
      .addText((text) =>
        text
          .setPlaceholder("Owner")
          .setValue(this.plugin.settings.githubOwner)
          .onChange(async (value) => {
            this.plugin.settings.githubOwner = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Repository")
      .setDesc("Name of the repository to sync")
      .addText((text) =>
        text
          .setPlaceholder("Repository")
          .setValue(this.plugin.settings.githubRepo)
          .onChange(async (value) => {
            this.plugin.settings.githubRepo = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Repository branch")
      .setDesc("Branch to sync")
      .addText((text) =>
        text
          .setPlaceholder("Branch name")
          .setValue(this.plugin.settings.githubBranch)
          .onChange(async (value) => {
            this.plugin.settings.githubBranch = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Sync").setHeading();

    const syncStrategies = {
      manual: "Manually",
      interval: "On Interval",
    };
    const uploadStrategySetting = new Setting(containerEl)
      .setName("Sync strategy")
      .setDesc("How to sync files with remote repository");

    let syncInterval = "1";
    if (this.plugin.settings.syncInterval) {
      syncInterval = this.plugin.settings.syncInterval.toString();
    }
    const intervalSettings = new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Interval in minutes between automatic syncs")
      .addText((text) =>
        text
          .setPlaceholder("Interval in minutes")
          .setValue(syncInterval)
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = parseInt(value) || 1;
            await this.plugin.saveSettings();
            // We need to restart the interval if the value is changed
            this.plugin.restartSyncInterval();
          }),
      );
    intervalSettings.setDisabled(
      this.plugin.settings.syncStrategy !== "interval",
    );

    uploadStrategySetting.addDropdown((dropdown) =>
      dropdown
        .addOptions(syncStrategies)
        .setValue(this.plugin.settings.syncStrategy)
        .onChange(async (value: keyof typeof syncStrategies) => {
          intervalSettings.setDisabled(value !== "interval");
          this.plugin.settings.syncStrategy = value;
          await this.plugin.saveSettings();
          if (value === "interval") {
            this.plugin.startSyncInterval();
          } else {
            this.plugin.stopSyncInterval();
          }
        }),
    );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Sync when Obsidian starts and when you come back to it")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync configs")
      .setDesc("Sync Vault config folder with remote repository")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncConfigDir)
          .onChange(async (value) => {
            this.plugin.settings.syncConfigDir = value;
            if (value) {
              await this.plugin.syncManager.addConfigDirToMetadata();
            } else {
              await this.plugin.syncManager.removeConfigDirFromMetadata();
            }
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Keep media on this device")
      .setDesc(
        "Images, video, audio and PDF files created here are never uploaded, " +
          "unless they sync through GitHub Releases (see below). " +
          "Media files that are already in the repository still sync.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.keepMediaLocal)
          .onChange(async (value) => {
            this.plugin.settings.keepMediaLocal = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Media file extensions")
      .setDesc("Comma separated extensions treated as media by the setting above")
      .addTextArea((text) =>
        text
          .setPlaceholder(MEDIA_EXTENSIONS)
          .setValue(this.plugin.settings.mediaExtensions)
          .onChange(async (value) => {
            this.plugin.settings.mediaExtensions = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Videos and audio").setHeading();

    new Setting(containerEl)
      .setName("Sync videos and audio through GitHub Releases")
      .setDesc(
        "Files with the extensions below are kept in a draft release of the " +
          "repository instead of the repository itself, so every device gets " +
          "them without filling the repository.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.releaseMedia)
          .onChange(async (value) => {
            this.plugin.settings.releaseMedia = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Video and audio file extensions")
      .setDesc("Comma separated extensions synced through the release")
      .addTextArea((text) =>
        text
          .setPlaceholder(RELEASE_EXTENSIONS)
          .setValue(this.plugin.settings.releaseExtensions)
          .onChange(async (value) => {
            this.plugin.settings.releaseExtensions = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Largest file to sync (MB)")
      .setDesc(
        "Larger files stay on the device that has them. A phone may not " +
          "have the memory for very large files.",
      )
      .addText((text) =>
        text
          .setPlaceholder("100")
          .setValue(`${this.plugin.settings.releaseMaxSizeMB}`)
          .onChange(async (value) => {
            const size = Number(value);
            if (Number.isFinite(size) && size > 0) {
              this.plugin.settings.releaseMaxSizeMB = size;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Download videos and audio from other devices")
      .setDesc(
        "Turn off on a device short of storage. It still uploads its own files.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.downloadReleaseMedia)
          .onChange(async (value) => {
            this.plugin.settings.downloadReleaseMedia = value;
            await this.plugin.saveSettings();
          });
      });

    const conflictHandlingOptions = {
      overwriteLocal: "Overwrite local file",
      ask: "Ask",
      overwriteRemote: "Overwrite remote file",
    };
    new Setting(containerEl)
      .setName("Conflict handling")
      .setDesc(
        `What to do in case remote and local files conflict
        when downloading from GitHub repository`,
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(conflictHandlingOptions)
          .setValue(this.plugin.settings.conflictHandling)
          .onChange(async (value: keyof typeof conflictHandlingOptions) => {
            this.plugin.settings.conflictHandling = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName("Interface").setHeading();

    new Setting(containerEl)
      .setName("Show status bar item")
      .setDesc("Displays the status bar item that show the file sync status")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showStatusBarItem)
          .onChange((value) => {
            this.plugin.settings.showStatusBarItem = value;
            this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show sync button")
      .setDesc("Displays a ribbon button to sync files")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showSyncRibbonButton)
          .onChange((value) => {
            this.plugin.settings.showSyncRibbonButton = value;
            this.plugin.saveSettings();
            if (value) {
              this.plugin.showSyncRibbonIcon();
            } else {
              this.plugin.hideSyncRibbonIcon();
            }
          });
      });

    new Setting(containerEl)
      .setName("Show conflicts view button")
      .setDesc("Displays a ribbon button that opens the conflicts view")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showConflictsRibbonButton)
          .onChange((value) => {
            this.plugin.settings.showConflictsRibbonButton = value;
            this.plugin.saveSettings();
            if (value) {
              this.plugin.showConflictsRibbonIcon();
            } else {
              this.plugin.hideConflictsRibbonIcon();
            }
          });
      });

    const diffModeOptions = {
      default: "Default",
      unified: "Unified",
      split: "Split",
    };
    new Setting(containerEl)
      .setName("Conflict resolution view mode")
      .setDesc("Set which diff view mode should be shown in case of conflicts")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(diffModeOptions)
          .setValue(this.plugin.settings.conflictViewMode)
          .onChange(async (value: keyof typeof diffModeOptions) => {
            this.plugin.settings.conflictViewMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName("Extra").setHeading();

    new Setting(containerEl)
      .setName("Enable logging")
      .setDesc(
        "If enabled logs from this plugin will be saved in a file in your config directory.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableLogging)
          .onChange((value) => {
            this.plugin.settings.enableLogging = value;
            if (value) {
              this.plugin.logger.enable();
            } else {
              this.plugin.logger.disable();
            }
            this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Copy logs")
      .setDesc("Copy the log file content, this is useful to report bugs.")
      .addButton((button) => {
        button.setButtonText("Copy").onClick(async () => {
          const logs: string = await this.plugin.logger.read();
          try {
            await copyToClipboard(logs);
            new Notice("Logs copied", 5000);
          } catch (err) {
            new Notice(`Failed copying logs: ${err}`, 10000);
          }
        });
      });

    new Setting(containerEl)
      .setName("Clean logs")
      .setDesc("Delete all existing logs.")
      .addButton((button) => {
        button.setButtonText("Clean").onClick(async () => {
          await this.plugin.logger.clean();
        });
      });

    new Setting(containerEl)
      .setName("Reset")
      .setDesc("Reset the plugin settings and metadata")
      .addButton((button) => {
        button
          .setButtonText("RESET")
          .setCta()
          .onClick(() => {
            const modal = new Modal(this.plugin.app);
            modal.setTitle("Are you sure?");
            modal.setContent(
              "This will completely delete all sync metadata and plugin settings.\n" +
                "You'll have to repeat the first sync if you want to use the plugin again.",
            );
            new Setting(modal.contentEl);
            new Setting(modal.contentEl)
              .addButton((btn) =>
                btn
                  .setButtonText("Reset")
                  .setCta()
                  .onClick(async () => {
                    await this.plugin.reset();
                    modal.close();
                  }),
              )
              .addButton((btn) =>
                btn.setButtonText("Cancel").onClick(() => {
                  modal.close();
                }),
              );
            modal.open();
          });
      });
  }
}
