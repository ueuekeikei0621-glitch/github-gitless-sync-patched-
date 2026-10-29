export interface GitHubSyncSettings {
  firstSync: boolean;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  syncStrategy: "manual" | "interval";
  syncInterval: number;
  syncOnStartup: boolean;
  syncConfigDir: boolean;
  conflictHandling: "overwriteLocal" | "ask" | "overwriteRemote";
  conflictViewMode: "default" | "unified" | "split";
  showStatusBarItem: boolean;
  showSyncRibbonButton: boolean;
  showConflictsRibbonButton: boolean;
  enableLogging: boolean;
  keepMediaLocal: boolean;
  mediaExtensions: string;
  releaseMedia: boolean;
  releaseExtensions: string;
  releaseMaxSizeMB: number;
  downloadReleaseMedia: boolean;
}

const VIDEO_AUDIO_EXTENSIONS =
  "mp4, mov, m4v, webm, mkv, ogv, avi, 3gp, " +
  "mp3, m4a, wav, aac, ogg, oga, opus, flac";

// Images, video, audio and PDF, as Obsidian can embed them.
export const MEDIA_EXTENSIONS =
  "png, jpg, jpeg, gif, webp, heic, heif, avif, bmp, tif, tiff, svg, " +
  VIDEO_AUDIO_EXTENSIONS +
  ", pdf";

// Synced through a release of the repository instead of the repository.
export const RELEASE_EXTENSIONS = VIDEO_AUDIO_EXTENSIONS;

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
  firstSync: true,
  githubToken: "",
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  syncStrategy: "manual",
  syncInterval: 1,
  syncOnStartup: false,
  syncConfigDir: false,
  conflictHandling: "ask",
  conflictViewMode: "default",
  showStatusBarItem: true,
  showSyncRibbonButton: true,
  showConflictsRibbonButton: true,
  enableLogging: false,
  keepMediaLocal: true,
  mediaExtensions: MEDIA_EXTENSIONS,
  releaseMedia: true,
  releaseExtensions: RELEASE_EXTENSIONS,
  releaseMaxSizeMB: 100,
  downloadReleaseMedia: true,
};
