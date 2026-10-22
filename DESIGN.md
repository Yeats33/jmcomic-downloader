# jmcomic-downloader interface

## 1. Identity
Keep the existing compact Naive UI desktop interface and orange action controls. Reading uses a quiet black canvas with neutral toolbars so the page remains the focus.

## 2. Color
Use the existing App.vue theme: primary #FF7A00, hover #FFB152, pressed #D96200; Naive UI default light surfaces and text. The reader uses black, gray-9 toolbars, gray-7 separators, white text, gray-3 secondary text, and red-3 errors.

## 3. Typography
Retain the system sans-serif stack. Use 14px body text, existing small control labels, and semibold titles. Long comic and chapter names truncate without pushing controls offscreen.

## 4. Spacing and layout
Use the existing 4px spacing unit. Toolbars wrap on narrow windows; scrolling belongs to the page canvas or chapter list. Reader controls remain visible above and below the canvas, with a full-height overlay.

## 5. Components and states
Reuse NButton, NRadioGroup/NRadioButton, NSelect, NInputNumber, NSpin and NAlert. Online reading is a third chapter mode alongside downloading and exporting. A chapter opens from its own reading button. Show page position, incoming bytes, loading, retry and empty states. The online reader toolbar includes a labeled forward-buffer page count from 0 to 50, with 0 disabling preloading and 1 as the default. Changes apply immediately and use the existing automatic configuration saving. Local reading keeps its existing controls.

Both readers share a ReaderViewport (single page or continuous vertical scrolling) and ReaderNavigation (previous/next, labeled page input, layout and zoom). The viewport alone owns scrolling between fixed, wrapping toolbars. Continuous pages retain their measured aspect ratios when online images are evicted, so cache trimming does not move the reading position. A reader records only successfully loaded positions. The reading-history tab shows the saved chapter, page and local/online mode, with a Continue Reading action and actionable missing-file/network errors.

The inventory toolbar uses labeled search, tag, completeness and sort controls. Filters apply before pagination; changing them clears the visible selection. A result count and an empty state make the filter scope explicit. Context-menu deletion acts on highlighted rows; the toolbar deletion acts on checkboxes. The confirmation names the affected comics.

## 6. Interaction
Local and online chapter menus share ordered navigation. Automatic next-chapter is opt-in and only follows a forward page action or a forward scroll at the loaded chapter end. Unavailable local chapters are labeled and disabled. Reader additions use compact labeled controls and wrapping toolbars; thumbnail and bookmark panels are collapsible regions within the reader, not nested modal dialogs. Display settings persist per comic with an explicit action to save a global default. Update and integrity checks show a preview before starting downloads; report partial failures beside the affected item.

Retain arrow-key paging, Escape to close, and zoom controls. Ignore reader shortcuts while typing or choosing a chapter. Respect reduced motion. Closing or switching chapters cancels obsolete transfers and releases image object URLs.

## 7. Accessibility
Name icon-only controls, expose loading/error status, retain keyboard focus indicators and useful image alt text. Page controls are disabled at boundaries. At narrow widths, controls wrap instead of overflowing.

## 8. Accepted constraints
This is an extension of the existing Vue/Naive UI app, not a visual redesign. Online pages arrive on demand through Tauri channels; scrambled images require a complete page before reconstruction. Keep the current page, the previous page, and the configured number of following pages in memory. Load following pages sequentially so a larger buffer does not queue a whole chapter ahead of the current page.
