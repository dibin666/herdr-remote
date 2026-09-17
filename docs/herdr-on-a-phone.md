# Herdr on a phone screen

herdr-remote paints whatever Herdr draws. On a laptop that is the point; on a
phone, roughly a third of a 40-column viewport goes to Herdr's own chrome before
an agent has printed anything.

None of this is herdr-remote configuration. It is Herdr's own `config.toml`,
which every client on the workstation shares — including the one in front of
you. Trim what you do not read rather than what you do.

Check any change before trusting it, and apply it without a restart:

```bash
herdr config check
herdr server reload-config
```

`config check` prints the parse error and the line; a config that fails to parse
is silently replaced by the defaults, which is easy to mistake for "the setting
did nothing".

## Give the terminal the width back

```toml
[ui]
# The sidebar is a navigation aid, and a phone has the tab bar for that.
sidebar_start_collapsed = true
# "compact" keeps a narrow status rail; "hidden" is zero width.
sidebar_collapsed_mode = "hidden"
sidebar_width = 18

# One tab does not need a tab bar.
hide_tab_bar_when_single_tab = true

# Distinct glyphs per state instead of coloured dots — legible at a phone's
# font size, and legible to anyone who does not separate red from green.
status_indicators = "symbols"
```

## Drop the tokens that are always the same

New in Herdr 0.9.1: a sidebar token can carry **rules**, and a rule that matches
can hide the token *and its separator*. A row with nothing left disappears
entirely, so this reclaims whole lines rather than leaving ragged punctuation.

```toml
[ui.sidebar.agents]
row_gap = 0
rows = [
  # "Local" names the only machine most workstations have. Hide it there and it
  # still appears for a machine reached over SSH.
  ["state_icon", { token = "machine", rules = [{ equals = "Local", hide = true }] }, "workspace"],
  ["terminal_title_stripped"],
]

[ui.sidebar.spaces]
row_gap = 0
rows = [
  ["state_icon", "workspace"],
  # The branch is worth a line when it is not the one you expect.
  [{ token = "branch", rules = [{ equals = "main", hide = true }] }],
]
```

Rules only apply to text-valued tokens. Asking for one on a token Herdr renders
itself — `git_status`, `state_icon` — fails with *"sidebar rules require a
text-valued token"*, which `herdr config check` will tell you before the phone
does. A token accepts at most 16 rules.

Matchers include `equals`, `starts_with`, `gt` and `lt`, with `ignore_case` to
loosen the comparison. Alongside `hide` a rule can also restyle a match with
`fg`, `bold` and `dim`, so a blocked agent can be made loud on a small screen
rather than merely present.

## What herdr-remote does on its own

You do not have to configure these:

- the browser tab is named after **that window's** Herdr client, so two phones
  on two workspaces are told apart in the tab strip (Herdr 0.9.1);
- the agent chip in the status bar reports blocked, done and working counts read
  from Herdr's socket API, so finding a blocked agent does not mean driving the
  sidebar. On a phone it shows only the most urgent of the three;
- a long-press on a URL offers to open it **on the phone**, rather than on the
  workstation the way Herdr's own link handling does.
