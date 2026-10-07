# Island activity API

Any program or script can put an item on the island: a build running, a backup finishing, a long job in another tool. Island must be running and the **Other apps** activity must be on (it is by default).

## Sending an item

`island-hook.exe activity` reads one JSON object from stdin and hands it to the island. The exe lives at `%LOCALAPPDATA%\Island\bin\island-hook.exe` (Island copies it there every time it starts). It gives up after about two seconds, prints nothing and exits 0 even when Island is not running, so it is safe to call from a build script.

PowerShell, one line:

```powershell
'{"id":"backup","title":"Backup","text":"Copying photos","icon":"upload","progress":0.4}' | & "$env:LOCALAPPDATA\Island\bin\island-hook.exe" activity
```

PowerShell, building the JSON from an object (`$null` becomes `null`, an indeterminate bar):

```powershell
@{ id = 'build'; title = 'Build'; text = 'Compiling'; icon = 'hourglass'; progress = $null } |
  ConvertTo-Json -Compress | & "$env:LOCALAPPDATA\Island\bin\island-hook.exe" activity
```

cmd:

```bat
echo {"id":"build","title":"Build finished","icon":"check","tone":"good","ms":6000} | "%LOCALAPPDATA%\Island\bin\island-hook.exe" activity
```

Windows PowerShell 5.1 pipes plain ASCII to programs. If a title has accents or emoji, run `$OutputEncoding = [Text.Encoding]::UTF8` first (PowerShell 7 already does this).

A typical job is three messages with the same `id`:

```json
{"id":"build","state":"start","title":"Building","icon":"hourglass","progress":null}
{"id":"build","progress":0.6,"text":"Step 3 of 5"}
{"id":"build","state":"end"}
```

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Required, up to 80 characters. Names the item: send the same `id` again to update it. |
| `title` | string | The headline, up to 80 characters. |
| `text` | string | A second line, shown when the island is expanded. Up to 160 characters. |
| `icon` | string | An Island icon name, such as `check`, `bell`, `upload`, `hourglass`, `terminal`, `code`, `alert`, `bolt`, `cloud`, `folder`. Unknown names show `stack`. Full list in `src/core/icons.ts`. |
| `tone` | string | Colour of the icon and bar: `default`, `muted`, `dim`, `accent`, `claude`, `good`, `warn`, `bad`, `info` or `violet`. |
| `progress` | number or null | `0` to `1` draws a bar. `null` draws an indeterminate bar. Leave it out for no bar. |
| `state` | string | `start`, `update` (the default) or `end`. `end` removes the item. |
| `ms` | number | Remove the item this many milliseconds after this message (at most 24 hours). |
| `url` | string | Adds an Open button. Only `https://` links and `http://localhost[:port]` links are accepted. |
| `urgent` | boolean | Shakes the island when the item appears or changes. If Interrupt is on for Other apps (Activities page), it also takes the island until you tap away. |

## How items behave

- Fields you leave out keep their previous value, so `{"id":"build","progress":0.6}` is a complete update.
- A new `id`, or a changed `title` or `text`, pops the island open for a moment. Progress-only updates stay quiet.
- `ms` counts from the message that carries it; a message without `ms` leaves the running timer alone.
- Up to 10 items are kept. The most recently updated one is shown, with a `+N` for the others. The oldest is dropped past 10.
- Invalid JSON, a missing `id` and unsafe `url` values are ignored without an error.
