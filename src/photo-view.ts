import { Plugin } from "obsidian";

// Photos in notes are shown no taller than a set height, so the text around
// them stays readable, and a tap opens them full screen.
//
// The full screen view is Obsidian's own lightbox (Obsidian 1.13 and later):
// pinch to zoom, swipe to the other photos of the note, swipe down to close.
// It opens on the first tap in reading view, but in editing view the first
// tap only selects the photo and the next one opens it. With "Open a photo
// with one tap" the first tap opens it there too: once Obsidian has selected
// the photo, it's given the second tap it waits for.

// On <body> while photos are shown small; styles.css does the rest.
export const SMALL_PHOTOS_CLASS = "ggs-small-photos";
// The height they're shown at.
export const SMALL_PHOTO_HEIGHT_VAR = "--ggs-small-photo-height";

export interface PhotoViewSettings {
  smallPhotos: boolean;
  smallPhotoHeight: number;
  openPhotosWithOneTap: boolean;
}

export default class PhotoView {
  // Set while the second tap is passed on, so it isn't handled again
  private passingTap = false;

  constructor(
    private plugin: Plugin,
    private settings: () => PhotoViewSettings,
  ) {}

  start() {
    this.apply();
    // Before Obsidian's own handlers, which select the photo
    this.plugin.registerDomEvent(document, "click", (evt) => this.onClick(evt), {
      capture: true,
    });
  }

  // Shows photos small or as they are, as the settings say.
  apply() {
    const body = document.body;
    if (!body) {
      return;
    }
    const { smallPhotos, smallPhotoHeight } = this.settings();
    body.classList.toggle(SMALL_PHOTOS_CLASS, smallPhotos);
    body.style.setProperty(SMALL_PHOTO_HEIGHT_VAR, `${smallPhotoHeight}px`);
  }

  stop() {
    const body = document.body;
    if (!body) {
      return;
    }
    body.classList.remove(SMALL_PHOTOS_CLASS);
    body.style.removeProperty(SMALL_PHOTO_HEIGHT_VAR);
  }

  private onClick(evt: MouseEvent) {
    if (this.passingTap || !this.settings().openPhotosWithOneTap) {
      return;
    }
    if (evt.button !== 0 || evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) {
      return;
    }
    const img = evt.target as HTMLElement | null;
    if (!img || img.tagName !== "IMG") {
      return;
    }
    // A photo the editor shows: Obsidian puts it in an image wrapper and opens
    // it on a tap once it's selected. If it's selected already, this tap opens
    // it.
    const embed = img.parentElement?.classList.contains("image-wrapper")
      ? img.parentElement.closest(".image-embed")
      : null;
    if (
      !embed ||
      !embed.closest(".cm-content") ||
      embed.classList.contains("is-selected")
    ) {
      return;
    }
    // After Obsidian has handled this tap
    window.setTimeout(() => {
      // Selected by it and not open yet (an Obsidian older than 1.13 doesn't
      // select photos, and one that opens them on the first tap has)
      if (
        !img.isConnected ||
        !embed.classList.contains("is-selected") ||
        img.ownerDocument.querySelector(".lightbox")
      ) {
        return;
      }
      this.passingTap = true;
      try {
        img.click();
      } finally {
        this.passingTap = false;
      }
    }, 0);
  }
}
