# iOS PWA Navbar & Safe Area: How We Fixed It

## The Problem

On iOS, when a web app is installed as a PWA (Add to Home Screen), the bottom navigation bar had excessive padding beneath it. The tab icons and build hash were pushed up, leaving a large empty gap at the bottom of the screen.

## Root Cause

iOS applies **safe area insets** to protect content from being obscured by system UI — the home indicator bar on Face ID devices, or the status bar at the top. The CSS mechanism for this is:

```css
/* This tells iOS to extend the viewport into safe areas */
<meta name="viewport" content="..., viewport-fit=cover">

/* Then you use env() to manually add padding where needed */
padding-bottom: env(safe-area-inset-bottom);
```

The problem: in a **standalone PWA**, there is no browser chrome at the bottom (no URL bar, no tab bar). The home indicator is a thin translucent line that overlays content — it doesn't need reserved space. So `env(safe-area-inset-bottom)` was reserving ~34px of dead space for nothing.

## What We Tried (and Why It Failed)

1. **Reducing `--safe-bottom` to half the inset** — still left visible padding since even half of 34px is noticeable.
2. **Setting tab bar height explicitly** — the height was correct but padding-bottom was adding space *below* the set height, doubling the gap.
3. **Media query `(display-mode: standalone)`** — this works in Chrome/Android but iOS Safari doesn't reliably support it for safe area overrides.
4. **Moving the build hash to `position: absolute; bottom: 0`** inside the tab bar — it ended up behind the tab labels because the safe area padding pushed everything up.

## The Fix

Two changes solved it completely:

### 1. Remove `viewport-fit=cover` from the viewport meta tag

```html
<!-- Before -->
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

<!-- After -->
<meta name="viewport" content="width=device-width, initial-scale=1">
```

Without `viewport-fit=cover`, iOS doesn't report any safe area insets via `env()`. The browser handles the home indicator overlay itself — content extends to the true bottom of the screen.

### 2. Set `--safe-bottom: 0px` globally

```css
:root {
    --safe-bottom: 0px;
}
```

All layout calculations (content padding, player position, tab bar) reference `--safe-bottom`. Setting it to 0 ensures no component adds phantom padding.

### 3. Raise the tab bar slightly (4px)

```css
#tab-bar {
    position: fixed; bottom: 4px; /* not 0 — gives breathing room above home indicator */
}
```

A tiny 4px lift keeps the tab bar from sitting directly on the home indicator line without wasting space.

## Key Insight

**PWAs don't need `viewport-fit=cover`** unless you specifically want to draw behind the status bar or home indicator (e.g., full-bleed images). For a standard app layout with a fixed navbar, removing it is the cleanest solution — iOS will handle the home indicator overlay automatically, and you don't need to manage safe area insets at all.

## Files Changed

- `index.html` — removed `viewport-fit=cover` from viewport meta
- `style.css` — set `--safe-bottom: 0px`, tab bar `bottom: 4px`, removed standalone media query
