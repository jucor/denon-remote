# yTuner bookmarks ("Favourites")

What yTuner does with `bookmark.xml`, read from the source of
[coffeegreg/YTuner](https://github.com/coffeegreg/YTuner) (`src/*.pas`, `APP_VERSION = '1.2.6'`,
`common.pas:32`). Citations are `file:line` in that tree. This is what `lib/bookmarks.js` is built
on; it is not verified against a running yTuner or the receiver.

## (a) File name and location

- `GetBookmarkFileName` (`bookmark.pas:34-38`): `ConfigPath + '/' + MAC + '.xml'`, but with
  `CommonBookmark` the MAC is replaced by the constant `PATH_BOOKMARK = 'bookmark'`
  (`bookmark.pas:15,36`). So with `CommonBookmark=1` the file is **`bookmark.xml`**; without it,
  one `<MAC>.xml` per receiver.
- `CommonBookmark` is read from `ytuner.ini` section `[Bookmark]`, key `CommonBookmark`
  (`common.pas:113`, `ytuner.pas:279-281`); the unit default is `False` (`bookmark.pas:29`) but yTuner
  writes `1` into a new ini and reads it back with default `True`.
- `ConfigPath` ends in the `config` sub-folder (`ytuner.pas:179-183`, `common.pas:169`), and
  `stations.ini` is read from the same place (`ytuner.pas:56-58`). So `bookmark.xml` sits **next to
  `stations.ini`**: `path.join(path.dirname(stationsFile), 'bookmark.xml')`.
- Other `[Bookmark]` keys: `Enable` (`ytuner.pas:275-277`, hides the menu entry,
  `httpserver.pas:214-217`) and `BookmarkStationsLimit`, default 100 (`bookmark.pas:19`,
  `ytuner.pas:283-285`).

## (b) Item XML and ids

`SetBookmark` stores the `<Item>` that yTuner just generated for a station
(`httpserver.pas:305-309`, `bookmark.pas:217-222`), so an Item is a `TVTunerStation.Add2XML`
(`vtuner.pas:178-201`). Children, in this order:

| Element | Meaning |
|---|---|
| `ItemType` | always `Station` |
| `StationId` | bookmark id (below) |
| `StationName` | display name |
| `StationUrl` | direct stream URL (https rewritten to http for receivers configured "all as http", `avr.pas:107-125`) |
| `StationDesc` | description; `My favorite "<name>"` for My Stations (`httpserver.pas:992`), `<name> : <homepage>` for radio-browser (`httpserver.pas:1016`) |
| `Logo` | `http://<host>/ytuner/icon?id=<MS_/RB_ id>` (`httpserver.pas:995,1024`) |
| `StationFormat` | genre / tags / My Stations category |
| `StationLocation` | country (radio-browser only) |
| `StationBandWidth` | bitrate (radio-browser only) |
| `StationMime` | `MP3`, `AAC` or `WMA`, else empty (`vtuner.pas:60,196`) |
| `Relia` | always `3` |
| `Bookmark` | `http://<host>/setupapp/favxml.asp?id=<MS_/RB_ id>&fav=add`, stored as `fav=del` (`httpserver.pas:997,1025`, `bookmark.pas:219`) |

Empty values are written as empty elements. In the stored file the host in `Logo` and `Bookmark` is
replaced by the placeholder `ytunerhost` (`bookmark.pas:220-221`, `common.pas:37`) and swapped back
to the real host on every read (`bookmark.pas:89-90,148-150`).

File skeleton: root `ListOfItems`, first child `ItemCount`, then the `Item`s
(`bookmark.pas:190-192`). Written by FPC's `WriteXMLFile`; I believe that emits an `<?xml
version="1.0"?>` line and two-space indentation, which `lib/bookmarks.js` imitates, but that comes from
FPC's library, not from this tree. The reader ignores whitespace either way.

**Ids.**

- MyStations: `MS_` + first 12 hex of `MD5(name + url)`, upper-case (`my_stations.pas:94-95`),
  `name`/`url` as written in `stations.ini`.
- radio-browser: `RB_` + first 12 characters of the station UUID without dashes, upper-case
  (`httpserver.pas:1006`; looked up by `GetRBStationByID`, `radiobrowser.pas:335-362`, which matches
  the first 14 characters of the dashed UUID).
- **In `bookmark.xml` the `_` becomes `B`** (`httpserver.pas:305`): `MSB…` / `RBB…`. The `B` at index 2
  is what routes the receiver's later lookup to the bookmark file (see c). `Logo` and `Bookmark`
  keep the `_` form.

## (c) How a bookmarked item plays

- Browsing: the "Favourites" menu entry (`httpserver.pas:214-217`) leads to `/ytuner/bookmark`
  (`httpserver.pas:143`), which returns the stored Items **verbatim** with only the host and, if the
  receiver's translator is on, the name rewritten (`GetBookmark`, `bookmark.pas:67-115`).
- Selecting an item: `statxml.asp?id=<StationId>` is routed on the id's third character
  (`httpserver.pas:254`). `_` means resolve through MyStations / radio-browser
  (`GetStationInfo`, `httpserver.pas:880-915`); **`B` means return the stored Item from the bookmark
  file** (`GetBookmarkStationInfo`, `bookmark.pas:117-170`). Nothing re-resolves a `…B…` id: the
  receiver plays the `StationUrl` that is in the file. (`PlayStation`, `httpserver.pas:664-695`,
  only handles `MS`/`RB` ids and is in the group marked "NOT tested with real AVR", `httpserver.pas:150-153`.)
- Therefore an entry we write plays **if** it is a well-formed Item with a direct `StationUrl`
  and a `…B…` id. It does not need to exist in `stations.ini` or radio-browser.
- What needs the `MS_`/`RB_` id to resolve: the `Logo` (icon route, `httpserver.pas:426-436`) and the
  `Bookmark` link the receiver calls for add/remove (`BookmarkService` runs `GetStationInfo`,
  `httpserver.pas:284-310`). An `RB_` id from a real radio-browser UUID resolves; an `MS_` id resolves
  only if the same name+URL is in `stations.ini`. Otherwise the receiver shows no logo and cannot
  un-favourite it from its own menu; removing from the web UI still works.

Traps in yTuner, all respected by `lib/bookmarks.js`:

1. `GetBookmark` dereferences `Logo`, `Bookmark` (`bookmark.pas:89-90`) and, with a translator,
   `StationName` (`:94`) without checking they have text. An empty `Logo` raises, the handler returns
   404 and **the whole Favourites menu disappears**. We never write them empty.
2. It indexes children by position (`ChildNodes[i+1]`, `:85-88`) from `ItemCount` (`:53`), so
   `ItemCount` must be the first child and equal the number of Items. We recompute it on every write.
3. `SetBookmark` only acts when `ItemCount < BookmarkStationsLimit` (`bookmark.pas:201`), **for
   deletes as well as adds**, so a list at the limit is frozen for the receiver. We cap adds at the
   limit (409) but always allow our own removes.
4. Add is a no-op if the `StationId` is present (`bookmark.pas:206-216`); removing the last Item
   deletes the file (`:228-235`). `add`/`remove` copy both.

## (d) Caching

None. `GetBookmarkItemsCount`, `GetBookmark`, `GetBookmarkStationInfo` and `SetBookmark` each call
`ReadXMLFile` on the file per request (`bookmark.pas:51,81,131,184`) and there is no module-level
copy. A change to the file shows on the receiver's next menu request, no restart or reload.
(Contrast `stations.ini`, which is parsed into memory at start and only re-read when the
optional `MyStationsAutoRefreshPeriod` timer sees a changed CRC32, `ytuner.pas:64-80,445-450`.)

Concurrency: `SetBookmark` is an unlocked read-modify-write with a non-atomic `WriteXMLFile`. Our
writes are atomic (tmp + rename) and serialised in-process, but a simultaneous add on the receiver and
on the web could still lose one update. Rare; the window is milliseconds.

## What this app implements

`lib/bookmarks.js`: `list` (id, name, logo), `add`, `remove`; `/api/radio/favourites` in
`lib/radioRoutes.js`. Added items use `RBB…` when the search result carries a radio-browser UUID,
else `MSB…` + MD5 of name+URL. `Logo` is the `ytunerhost` icon URL (the station's own favicon for an
`MSB…` item that has one); this assumes yTuner's `IconExtension` is unset (`httpserver.pas:86`,
`ytuner.pas:157-159`).

Open: the receiver's own behaviour is not in the yTuner source. Whether an item we wrote plays on the
RCD-N9 needs one manual check on the real receiver.
