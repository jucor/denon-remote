# Denon CEOL N7 Protocol Notes

## Connection
- TCP port 23 (telnet), single connection only
- Half duplex, commands terminated with `\r` (0x0D)
- Auto-discovered at 192.168.1.11

## Working Commands
- `PW?` / `PWON` / `PWSTANDBY` — power query/on/standby
- `SI?` / `SI<source>` — input source query/set
  - **Confirmed working**: `SICD`, `SIBLUETOOTH`, `SITUNER`, `SIUSB`, `SISERVER`, `SIIRADIO`, `SIANALOGIN`, `SIDIGITALIN1`, `SIDIGITALIN2`
  - **Silently ignored**: `SIBT`, `SIAUX1`, `SINET`, `SISPOTIFY`, `SIFAVORITES`, `SIOPTICAL`, `SIANALOG`, `SIAUXD`, `SIAUXB`, `SIDIGITALIN`, `SIDIGITAL IN`, `SISPDIF`
  - Note: Names differ from protocol PDF. Bluetooth = `SIBLUETOOTH` (not `SIBT`), Analog = `ANALOGIN` (not `AUXB`), Digital = `DIGITALIN1`/`DIGITALIN2` (not `AUXD`). Unrecognized source names are silently ignored — always verify with `SI?`.
  - Spotify Connect is not a selectable input; cast from the Spotify app to the receiver while on SERVER/IRADIO input.
- `MV?` / `MV<level>` / `MVUP` / `MVDOWN` — volume query/set/up/down (confirmed working on CD input)
- `MU?` / `MUON` / `MUOFF` — mute query/on/off

## CD Input Observations

### BDSTATUS Format
When on CD input, the receiver continuously streams `BDSTATUS` messages:
```
BDSTATUS 442000C1000000TTTTTCCC
```
Example sequence (track 1 playing):
```
BDSTATUS 442000C100000019000044
BDSTATUS 442000C100000019000045
...
BDSTATUS 442000C100000019000206
```
Then track 2 starts:
```
BDSTATUS 442000C100000029000003
BDSTATUS 442000C100000029000004
```

### Field breakdown
```
BDSTATUS HHHHHHSSTTTTTTTNMMMMSS
         ^^^^^^^^             — header (8 chars)
                 ^^^^^^^      — track number (7 digits, 1-indexed)
                        ^     — unknown separator (always 9?)
                         ^^^^ — minutes (4 digits, zero-padded)
                             ^^ — seconds (2 digits, zero-padded)
```

- Header byte 7 encodes transport state:
  - `C` = playing
  - `D` = paused
  - `B` = stopped
- Example: `442000C100000029000144` = playing, track 2, 1 min 44 sec

### Working CD Transport Commands
Source: [DRA-N5/RCD-N8 Protocol v1.0.0](https://assets.denon.com/documentmaster/uk/dran5_rcdn8_protocol_v100.pdf) page 13

- **`BDPLAY`** — play / resume (header changes to `C1`, counter resumes)
- **`BDPAUSE`** — pause (header changes to `D1`, counter freezes)
- **`BDPLAY PAUSE`** — play/pause toggle
- **`BDSTOP`** — stop (header changes to `B1`, counter resets)
- **`BDSKIP +`** — next track (confirmed: space before `+` is required!)
- **`BDSKIP -`** — previous track (space before `-` is required!)
- **`BDMANUAL SEARCH +`** — fast forward (search forward)
- **`BDMANUAL SEARCH -`** — fast reverse (search reverse)
- **`BDDS TRACK ****`** — direct select track number (0000-9999, e.g. `BDDS TRACK 0010`)
- **`BDOPEN/CLOSE`** — disc tray open/close
- **`BDREPEAT`** / **`BDREPEAT ONE`** / **`BDREPEAT ALL`** / **`BDREPEAT OFF`** — repeat modes
- **`BDRANDOM`** / **`BDRANDOM ON`** / **`BDRANDOM OFF`** — random/shuffle
- **`BDFOLDER MODE`** / **`BDFOLDER MODE ON`** / **`BDFOLDER MODE OFF`** — folder mode
- **`BDFOLDER +`** / **`BDFOLDER -`** — folder navigation
- **`BDSTATUS?`** — query system status
- **`BDFOLDER NAME?`** / **`BDFILE NAME?`** — query folder/file names
- **`BDARTIST NAME?`** / **`BDALBUM NAME?`** / **`BDSONG NAME?`** — query metadata

### Key lesson: space-separated parameters
The commands that didn't work earlier (`BDSKIP+`, `BDNEXT`, etc.) failed because
the protocol requires a **space** between the command verb and its parameter
(e.g. `BDSKIP +` not `BDSKIP+`).

### Initial query responses on CD input
```
PW? -> PWON
SI? -> SICD
         BDFOLDER NAME
         BDFILE NAME   <binary bytes>
```

## NSE/NSA Display Info Byte (lines 1-8)

The first byte after the line number in NSE/NSA responses is a bitmask:
- **Bit 1 (0x02)** = Playable Music (item is selectable/playable)
- **Bit 3 (0x08)** = Cursor Select (cursor is on this line)
- Other bits: Don't Care

Example: byte `0x0A` (0x02|0x08) = playable + cursor selected.
Note: The PDF labels these "Bit1" and "Bit4" but actual values show 0x02 and 0x08.

**No T9/text input**: The protocol has no character input commands. iRadio search uses
on-screen keyboard navigated with cursor commands — impractical over telnet. Use genre
browsing (cursor nav + page up/down) or vTuner web portal for search instead.

## Protocol Reference
- [DRA-N5/RCD-N8 Protocol PDF](https://assets.denon.com/documentmaster/uk/dran5_rcdn8_protocol_v100.pdf)
- Local copy: `dran5_rcdn8_protocol_v100.pdf` in this repo
- CD Control is documented as "N8 Only" but works on the RCD-N7 as well

## TODO
- Test metadata query commands (BDARTIST NAME?, BDALBUM NAME?, BDSONG NAME?)
- Decode remaining BDSTATUS header fields
- Test BDDS TRACK for direct track selection
