# Occlude

A local browser application for annotating burned-in text on DICOM and PNG images. It uses Cornerstone 5.8 for DICOM decoding and display, with a native-pixel rectangle editor.

## Run on this Mac

Double-click **Start Occlude.command**. It builds the app, starts a loopback-only server, and opens `http://127.0.0.1:5173`. Keep its Terminal window running while using the app. Stop it with Ctrl+C.

Or run:

```sh
npm ci             # first setup only; downloads application dependencies
npm run build
npm start
```

Then open `http://127.0.0.1:5173`. Node.js 22.12+ or a current supported release is required by the build tools. Dependencies are already installed in this checkout.

The OCR engine, its three WASM cores and its English language data are staged out of `node_modules` into the build by `npm run build`, which is why `dist/` is around 23 MB. Nothing is fetched at runtime: `tesseract.js` would otherwise resolve those from a CDN, and the browser test asserts that no request leaves the local origin during a detection.

All runtime scripts, workers, and compression codecs are bundled locally. Internet access is unnecessary after installation. The server accepts GET/HEAD requests for application assets only; it has no image-upload, storage, or annotation API. Files are read inside the browser. The server binds to 127.0.0.1, not the LAN. A content security policy restricts resource connections to the local origin.

## Workflow

1. Open DICOMs or PNGs, select a folder, or drop files/folders into the workspace. DICOM Part 10 files can have `.dcm`, `.dicom`, `.ima`, or no extension. Non-image files and unsupported/corrupt files produce an error. Exact duplicate file contents are detected using SHA-256.
2. Select a file in the library. **Previous** / **Next**, and the <kbd>←</kbd> / <kbd>→</kbd> keys when no box is selected, step through the current library view, skipping anything the filter or search hides, and the counter shows the position within that view. When the open file is not in the view — assigning its combo ID can drop it straight out of a **Needs combo ID** filter — the counter reads `— of N` and the buttons still step to the nearest shown file on either side. With no filter or search the counter and buttons behave exactly as an unfiltered list. For multiframe DICOMs, use the frame controls. Each frame owns its own boxes.
3. **DICOM tags** opens a read-only view of every element in the selected file — nested sequence items and private tags included — parsed off the main thread. Set the filter to **Identifying (PS3.15)** to narrow it to the attributes the DICOM PS3.15 Annex E Basic Confidentiality Profile treats as identifying; reading those values tells you which names, dates, and IDs may also be burned into the pixels. Every filter carries its own count. When the file sets Burned In Annotation `(0028,0301)`, its value is reported at the top of the panel, since that is the one metadata fact that speaks directly to this tool's job — confirm it against the image either way, as the attribute can be absent or wrong. This panel only reads: **it is a lens for finding identifying text, not a de-identification tool.** It never removes or rewrites a tag, the profile list describes metadata rather than the raster, and a tag missing from that list is not evidence that a file carries no PHI. Private tags are unvetted and have their own filter. Review `src/phi.js` against the current PS3.15 edition before treating the list as a completeness check.
4. Drag to draw a rectangle, select and move it, or resize with any of its eight handles. Shift-drag creates an overlapping box. Numeric fields accept exact native-pixel coordinates. Add optional notes.
   With a box selected, the arrow keys nudge it one native pixel, or ten with <kbd>Shift</kbd>; a box already against an edge does not move, and a run of presses collapses into a single undo step. <kbd>Tab</kbd> selects the next box and <kbd>Shift Tab</kbd> the previous one, but only while the canvas itself holds focus, so the rest of the page keeps normal tab order and a frame with no boxes never swallows the key. Cycling pans to a box that is off-screen. <kbd>Esc</kbd> unwinds one step at a time — cancel a drag, then deselect, then release the canvas — so a focused canvas can never trap keyboard navigation. Nudging and cycling are suspended while boxes are hidden or the redaction preview is on.
5. **Detect text** (or `T`) runs a locally bundled OCR engine over the image's native raster and proposes one dashed box per detected line. Click a suggestion — on the canvas, or in the **Detected text** panel where the read text is listed — to accept it as an ordinary zone.

   **The recognised text is never written into the note.** That text is the PHI, and a note is persisted to the workspace, written into project backups and into templates meant to be shared, and emitted in the pipeline export; putting detected text there would carry PHI into the tool's own deliverables. Detections are readable on screen while you decide and are held in memory only. An accepted zone is labelled `detected text`, which you can replace with a description of what the field is. **Workspace → Clear all notes** empties every note across files, imported layouts and saved templates in one action, without moving a single box — the remedy if text that should not leave this machine has been written into one. **Accept all** takes the rest; any suggestion can be dismissed. Accepted boxes are padded four pixels beyond the glyph bounds and clamped to the raster, because tight bounds clip glyph edges and a clipped box uncovers text. A **confidence floor** filters the detections already in hand — moving it never re-runs the engine and never discards anything, so lowering it brings weaker detections straight back. It defaults to 60%, which is roughly where clean overlay text separates from ultrasound speckle read as text lines; the panel always reports how many the floor is holding back. The panel also reports how many regions are shown and how many are **not covered by a zone**, treating a region as covered only when it lies wholly inside a single zone — partial overlap still leaves glyphs exposed. Nothing is accepted automatically and nothing unconfirmed reaches the export. Once accepted, suggestions are ordinary zones, so **Copy to…** propagates them across a combo under the same same-size-only rule.

   **OCR is a hint, never a clearance.** It misses text, especially low-contrast overlays, and it reports only what it found — "no text regions detected" is not a finding of "no text". The tool does not and cannot certify that an image is free of PHI; coverage remains the operator's judgement. A standing caveat sits in the panel for that reason and is not dismissible.
6. Reuse boxes instead of redrawing them. **Copy previous** (or `C`) pulls the previous frame's boxes into the open one. **Copy to…** copies the open frame's boxes to every other frame of the file, to the open frame of every same-size file, or to every frame of every same-size file — optionally restricted to files sharing the current combo ID. Only rasters with identical pixel dimensions are eligible; other sizes are skipped, never rescaled. Merging adds just the boxes a destination lacks and skips exact duplicates, keeping rectangles that differ only by note; replacing asks for confirmation. The dialog states how many boxes, frames, and files a copy will touch before anything is written, each destination frame keeps its own undo history, and a copy needs only the annotations — files whose sources are not currently connected still receive boxes.
7. **Templates** save the open frame's zones as a named layout for its combo and raster size, so a fresh batch can start with no reference file open. A template records the size it was built for and is **refused on any other raster** rather than rescaled; the refusal names how many files of the template's size are in the library. Apply to this frame, to every frame of this file, or to every frame of every same-size file in the combo — the dialog prices the operation before writing anything and merges by default, through the same planner **Copy to…** uses. Templates live in their own store, survive **Clear workspace**, and export and import as a small JSON so they can be shared or version-controlled alongside the redaction repository. A template is a starting point, not a guarantee: layouts drift across firmware and operator habit, so coverage still has to be checked on the actual images.
8. Zoom, pan, adjust window/level, or invert the display. These affect presentation only. Undo/redo tracks edits per file and frame. Original images are never modified.
9. Turn on **Preview** (or `R`) to fill every zone opaque black over the open image and confirm it covers the burned-in text. Because the pipeline applies one layout per combo and size, the preview shows that whole merged layout — including zones drawn on other frames and other samples of the same combo — and the status line reports how many of them came from elsewhere. Without a combo ID there is no pipeline group yet, so only the open frame's boxes are shown and the status line says so. Editing is suspended while the preview is on so nothing translucent can be mistaken for covered pixels; numeric coordinate fields still work, and the fill follows them live. Nothing is drawn over the result, so on an image with genuinely black surroundings a zone is invisible by design — the zone count in the status line is the check, and `R` returns you to the outlined boxes.
10. **Contact sheet** (or `G`) reviews a whole combo as thumbnails, each carrying the merged pipeline layout painted opaque — what Preview shows for one image, across every file at once, so a scanner variant that puts its strip in a different corner is obvious at a glance. Scope it to the combo, to the combo and one raster size, or to the whole library, and step the thumbnail size through four sizes with the − / + control. Each step re-decodes rather than upscaling, so enlarging a tile sharpens it; sizes are cached separately, so stepping back down is instant. Thumbnails decode lazily, cache as small rasters, and the grid renders a window of rows, so a large scope costs a screenful of decodes rather than all of them. Flags mark a thumbnail worth a second look: no zones, no combo ID, no reachable source, or detected text left uncovered. An unflagged thumbnail has not been checked — it has only failed to trip a flag.
11. The library is grouped by combination. Each group reports the **device the files themselves declare** — manufacturer, model and software version, with the SOP class on hover — read from `(0008,0070)`, `(0008,1090)`, `(0018,1020)` and `(0008,0016)` at import. A combo ID is a label somebody assigned and can be changed or mistyped; those four attributes are what actually determine the burned-in layout and never change for a given file. When a group contains more than one distinct signature it is badged **N devices** and the line reads `mixed devices`: either the combo ID is grouping files from different machines, or the layout assumption behind it is wrong. The open file states all four under its name. Files with no device tags say so rather than inheriting a neighbour's.

    Each group is collapsible and reports its file count, the raster sizes it contains, and how many of its files carry zones; a group whose combo could not be parsed from the filename is pinned at the top as **Unassigned** with a badge, so nothing is silently annotated under the wrong combo. Sizes are labelled within a group whenever more than one is present, because a zone only means anything at one raster size. **Jump to combo** expands and scrolls to a group directly. Collapsed groups are remembered with the workspace. The list is windowed — only the visible rows exist in the DOM — so a batch of a thousand files stays interactive.
12. Work through a batch using the library filter and search. The filter carries a live count in each of its own labels — **No boxes**, **Annotated**, **Needs combo ID**, **Source needed** — so those counts double as progress, and a view that empties means that part of the batch is done. **Needs combo ID** applies exactly the rule the export enforces, so it lists precisely the files blocking export. Search matches file name, relative path, and combo ID; the library count shows `shown of total` whenever a filter or search is narrowing it. Once the selected file has the right combo ID, **Apply combo N to N shown files** gives that ID to every file in the current view. The button always uses the selected file's *committed* ID rather than unsaved text in the field, reports how many files will change, warns which existing IDs it would overwrite, and asks for confirmation first. Combo IDs are not covered by undo.
13. Images and annotations save automatically in this browser's IndexedDB and reopen next time. Use the **same browser/profile and exact URL** (`127.0.0.1:5173`); `localhost`, another port, or another profile has separate storage. Check the save indicator before closing. Storage denial/quota failure leaves the editor usable in memory and shows a message. A second tab uses session-only mode to avoid overwriting the first tab's saved work.
14. **Import annotations.json** loads a pipeline export back in for review. Because that file is a layout — no source files, no frame ownership — imported zones attach to a combo and raster size rather than to any file, and stay listed even when no matching image is open. They are **held out of the export until you promote them**, so a layout produced by someone else is never re-exported without a deliberate pass; promoting records that you reviewed those zones, not that the layout is complete. Where a matching image is open, imported zones draw dotted over it for review. Removing a zone withdraws the promotion, because what was confirmed is no longer what would be exported. Import is additive — re-importing merges new zones into an existing layout — and a promoted layout contributes to the export in the ordinary way, merging and de-duplicating into the same combo and size grouping an annotated file would.
15. **Save backup** downloads a versioned project JSON with file hashes, dimensions, notes, and frame-specific boxes. It does not include source image bytes. Restore it and reopen the original files to reconnect missing images. Keep backups if you clear browser data. **Clear workspace** removes both saved images and annotations from this browser, leaving your original files untouched.

## Coordinates and pipeline export

The coordinate model is always the source raster: `(0,0)` at its top-left, x rightwards, y downwards, integer `{x,y,width,height}`. Canvas pointer positions use the inverse display transform. Device pixel ratio, zoom, pan, windowing, and DICOM physical pixel spacing never enter the saved geometry. The renderer displays the native raster with square display pixels so spatial calibration cannot stretch the annotation reference. This is a source-pixel annotation tool, not a calibrated measurement viewer.

DICOM reference dimensions come from Rows/Columns and are checked against decoded dimensions. PNG dimensions come from the decoded bitmap. A parsed filename dimension mismatch shows a warning; actual dimensions win. Out-of-bounds and zero-area boxes are rejected or clamped by the editing operation.

`combo{ID}_{WIDTH}x{HEIGHT}_s{N}.png` (and matching DICOM extensions) supplies a combo ID. IDs retain zero padding. For other filenames, enter the pipeline combo ID explicitly, or assign one across a filtered batch from the library view. The application never guesses a device combination from patient, study, or series metadata.

Two export formats are offered, chosen explicitly in the export panel. The selected one is named on the button, decides the file name, and is identifiable from the file itself.

**Attributes (v2)** is the default and is what the downstream repository is keyed by. Each entry is one device combination, carrying the four DICOM attributes read from the files — `(0008,0070)` Manufacturer, `(0008,1090)` ManufacturerModelName, `(0008,0016)` SOPClassUID and `(0018,1020)` SoftwareVersions — with `combo_id` retained only as a convenience label. Values are emitted exactly as the tag carried them: `dicom-parser` strips the padding byte DICOM appends to odd-length strings, and nothing beyond that is trimmed, collapsed or reformatted, because the downstream match is exact-string. An absent attribute is emitted as an empty string and `attributes_source` becomes `partial` rather than the entry being dropped; a promoted imported layout has no file to read and is marked `imported`.

```json
{
  "schema_version": 2,
  "generated_at": "2026-09-11T15:00:00.000Z",
  "annotations": [
    {
      "combo_id": "16",
      "manufacturer": "GE Medical Systems",
      "model": "LOGIQ9",
      "sop_class": "1.2.840.10008.5.1.4.1.1.6.1",
      "software_version": "LOGIQ9:R7.0.2",
      "attributes_source": "dicom_tags",
      "sizes": {
        "640x480": {
          "ref_width": 640,
          "ref_height": 480,
          "zones": [{"x": 0, "y": 0, "width": 420, "height": 40, "note": "name strip"}]
        }
      }
    }
  ]
}
```

Grouping is by the attributes, not the label. Where files sharing a combo ID disagree on their tags, **the tags win** — the same rule the tool already applies when a filename's dimensions disagree with the raster — and the disagreement is reported in the export panel and again before the file is written, naming the conflicting files. It is never silently merged.

Because v2 is keyed by attributes, a file with no combo ID exports with an empty label rather than being blocked. **Combo (v1, legacy)** is keyed by combo ID, so it still requires one on every annotated file, and is byte-identical to the original schema with no version field:

```json
{
  "generated_at": "2026-09-10T15:00:00.000Z",
  "annotations": {
    "16": {
      "640x480": {
        "ref_width": 640,
        "ref_height": 480,
        "zones": [{"x": 0, "y": 0, "width": 420, "height": 40, "note": "patient strip"}]
      }
    }
  }
}
```

Pipeline export is a **layout union across all files and frames in each combo + size**, plus any imported layout that has been promoted, with exact duplicates removed. Preview renders exactly that union for the open image, which is the only way to see the layout the pipeline will really apply to it. It has no frame indices and is not a frame-by-frame redaction recipe. Use the project backup when frame ownership must be preserved. Every annotated file must have a combo ID before pipeline export is enabled. Empty combos/sizes are omitted.

The legacy format carries **no schema version field**, deliberately: it stays byte-compatible with the consumer that reads it today, and its absence is what identifies it. v2 is self-describing through `schema_version`, so a consumer can tell the two apart by looking for that key.

## DICOM support and verification

Cornerstone decodes the source pixels using bundled worker/codecs. The application uses its dataset metadata provider (`useLegacyMetadataProvider: true`) to match its direct local-file loader, and its CPU renderer for VOI/modality LUT and color presentation. The project pins the Cornerstone core and loader together; their metadata APIs need checking when upgrading. Browser shims for `events` and `url` satisfy the metadata package's dependencies.

Automated browser checks use generated files with no patient information:

- Multiframe uncompressed little-endian DICOM; signed 16-bit pixels and rescale tags.
- MONOCHROME1, MONOCHROME2, RGB, RLE, and JPEG baseline compressed DICOM.
- Native boxes with non-square DICOM pixel spacing, fit/zoom, frame switching, undo/redo, and pipeline JSON.
- The PS3.15 identifying filter: nested references inside sequences, per-filter counts, composition with search, image geometry and pixel data excluded, and the Burned In Annotation notice.
- Keyboard editing: nudging with edge clamping, a burst of presses collapsing into one undo step, `Tab`/`Shift Tab` cycling with wrap, `Tab` falling through when there is nothing to cycle, and the `Esc` focus ladder.
- Previous/Next and arrow keys skipping hidden files, the position counter inside a view, and an open file that is outside the view.
- Pipeline import: a layout with no matching file listed and reviewable, held out of the export until promoted, merging with file zones without duplicating, and round-tripping to an equivalent file.
- Templates: saved from a frame, priced before writing, refused on a raster-size mismatch with the reason given, applied cold to a file with no reference open, and exported in a schema-valid file.
- Contact sheet: the merged layout sampled from a rendered thumbnail, lazy decoding, scope narrowing and widening, outlier flags, and click-through to the file.
- OCR with the network blocked: the engine, its core and its language data loading from disk, line suggestions padded and clamped inside the raster, acceptance only on request, and no completeness claim in any status string.
- Grouping by combination with per-size labelling, collapse, jump-to, and the pinned Unassigned group; and 1,000 files rendering a windowed slice with sub-frame filtering.
- Library filters with live counts, `shown of total`, combo-aware search, and a combo ID assigned across a filtered batch until the export unblocks.
- Redaction preview: opaque fill sampled from the rendered raster, a zone contributed by another frame, suspended editing, and the layout following the combo ID.
- Box reuse: the plan preview, propagation across frames, per-frame undo of a multi-frame copy, the keyboard copy, combo-filtered batch copies, and exclusion of differently sized rasters.
- Rail, toolbar, and frame-strip layout without overflow at 1500, 760, and 600 pixel viewport widths.
- Actual IndexedDB reload/recovery, source files, notes, display settings, and storage-denied fallback.
- Network inspection: only GET requests to the local application origin, no external requests or uploads.

Other Cornerstone transfer syntaxes, including JPEG-LS/JPEG 2000, are bundled but have not been verified against your device files. DICOM video transfer syntaxes, non-image DICOM objects, volumes/MPR, segmentation, and DICOM modification are outside this implementation.

```sh
npm test             # coordinate/reuse/schema/backup/storage checks
npm run build
npm run test:browser # local Chrome integration tests, isolated origin port 5174
```

The browser test requires Google Chrome (`channel: chrome`) and writes synthetic fixtures/screenshots to ignored `.test-output/`.

Both suites run in GitHub Actions on push and on pull requests (`.github/workflows/tests.yml`), as two parallel jobs so a logic error reports without waiting on Chrome. The browser job installs the Chrome channel build explicitly and installs `fonts-liberation`, because the layout-overflow checks measure rendered button widths and the OCR fixture draws monospaced text — both depend on the runner having Arial- and Courier-metric-compatible fonts. Failure screenshots upload as an artifact; every fixture is generated at run time from synthetic values, so nothing uploaded can contain PHI, and that must stay true if the suite is ever pointed at real files. Development: `npm run dev`. Production mode (`npm start`) is the tested offline runtime and uses the same stable port as development for persistence.

## Interface

The interface is monochrome by intent: hierarchy comes from value, weight and letter-spacing, and the only colour carries meaning — an amber rule on a warning, a muted red on a destructive action, and the annotation overlay on the canvas. Selection is white everywhere, never a hue. Every measurement is set in a tabular monospace so digits do not shift under the cursor and columns of figures align.

No web font is loaded: the content security policy limits `font-src` to `'self'` and the application is offline by design, so the type is a system stack (SF Pro on macOS) with a monospace companion. A self-hosted face can be added under the same policy if a specific licensed typeface is wanted — drop the file in `src/` and Vite will bundle it.

Annotation boxes draw a dark rule beneath a light one so an edge stays legible over any grey value, including the pure white of a burned-in caption strip. Unselected boxes are amber, selected boxes white with eight handles.

## Code map

- `src/main.js`: editor, library, frame navigation, history, autosave orchestration.
- `src/coordinates.js`: native-pixel geometry, zone identity, nudge clamping, selection cycling, the previewed per-combo layout, and the unchanged pipeline export schema.
- `src/reuse.js`: pure planning and application of box copies across frames and same-size files.
- `src/dicom.js`: Cornerstone local-file decoding and source-raster rendering.
- `src/layouts.js`: imported pipeline layouts — validation, additive merging, and the promotion gate.
- `src/templates.js`: named zone layouts — construction, size matching, ordering, and file validation.
- `src/contact.js`: pure contact-sheet scope, outlier flags, thumbnail scaling, and grid windowing.
- `src/ocr.js`: pure detection geometry — line extraction, padding, clamping, and conservative coverage.
- `src/ocr-engine.js`: the bundled OCR engine, pinned to locally staged assets and loaded on demand.
- `scripts/ocr-assets.mjs`: stages the engine, its WASM cores and its language data into the build.
- `src/device.js`: the four DICOM attributes that define a combination, their signature, and disagreement detection.
- `src/library.js`: pure library filtering, grouping by combination, windowed row flattening, cached box counts, view navigation, and combo-ID batch planning.
- `src/import.js`: file identification, dimension checks, SHA-256 identity.
- `src/storage.js`: IndexedDB files, workspace, and template stores.
- `src/project.js`: versioned annotation-backup validation.
- `src/tags.js`: DICOM element walk — dictionary names, VR resolution, character sets, sequences.
- `src/phi.js`: the PS3.15 Annex E identifying-attribute list, used as a read-only lens only.
- `src/tags.worker.js`, `src/tag-search.js`, `src/tag-viewer.js`: off-thread tag parsing, filtering, and the read-only tag dialog.
- `scripts/serve.mjs`: local static asset server; no image/data endpoints.

Current upstream dependency audits report advisories in Cornerstone's transitive ZIP/UUID dependencies and the development CommonJS plugin's esbuild dependency. There are no compatible upstream fixes for all findings. This app does not expose ZIP import/extraction or an esbuild development server; retain the lockfile and review upstream updates before expanding those capabilities.
