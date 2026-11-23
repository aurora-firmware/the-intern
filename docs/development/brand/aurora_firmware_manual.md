# Aurora Firmware - Brand Guidelines for The Round Table

## Typography

**Logo Typeface:**

The font families Bruno Ace and Josefin Sans are free and open-source.

Download from [Google Fonts](https://fonts.google.com/share?selection.family=Bruno+Ace|Josefin+Sans:ital,wght@0,100..700;1,100..700)

**Corporate Typography:**

Josefin Sans covers all communication needs - used in UI components, text content, and publications. Its variety of weights (100-700) unifies all design pieces.

In all layouts, Josefin Sans takes priority. Bruno Ace may be used for featured headings, the app title, or prominent labels.

### Application to The Round Table

| Element | Font | Weight | Usage |
|---------|------|--------|-------|
| App title "The Round Table" | Bruno Ace | Regular | Sidebar header, login/splash |
| Page headings (h1) | Bruno Ace | Regular | Dashboard, Boardroom, Decisions, etc. |
| Section headings (h2, h3) | Josefin Sans | SemiBold (600) | Card titles, section labels |
| Body text | Josefin Sans | Regular (400) | All body content, descriptions, chat messages |
| Labels & captions | Josefin Sans | Light (300) | Metadata, timestamps, status labels |
| Buttons & actions | Josefin Sans | SemiBold (600) | All interactive elements |
| Agent names & roles | Bruno Ace | Regular | Agent cards, chat headers |

---

## Colors

**Orange (Primary Accent):**

- HEX: #F7941D
- RGB: R247 G148 B29
- CMYK: C0 M50 Y91 K0
- Usage: Primary buttons, active states, highlights, important actions, accent borders

**Dark Blue (Primary Background):**

- HEX: #080A24
- RGB: R8 G10 B36
- CMYK: C100 M93 Y50 K75
- Usage: Sidebar background, dark surfaces, app shell, primary text on light backgrounds

**Red (Secondary Accent):**

- HEX: #E63B26
- RGB: R230 G59 B38
- CMYK: C0 M87 Y89 K0
- Usage: Alerts, destructive actions, error states, "revisited" decision status

### Logo Gradient

The logo features a gradient starting with Red (#E63B26) at the bottom-left corner, transitioning to Orange (#F7941D) at the midpoint. The gradient angle is 45 degrees. From the midpoint onward, the logo is solid Orange.

### Extended Palette for The Round Table

Derived from the core brand colors:

| Name | HEX | Usage |
|------|-----|-------|
| Dark Blue | #080A24 | Sidebar, dark backgrounds, primary text |
| Dark Blue Light | #0F1340 | Sidebar hover states, elevated dark surfaces |
| Dark Blue Muted | #1A1E4A | Card backgrounds on dark surfaces |
| Orange | #F7941D | Primary accent, buttons, active indicators |
| Orange Light | #FABA6A | Hover states on orange elements |
| Orange Subtle | #FEF3E2 | Light orange tint for backgrounds, highlights on light surfaces |
| Red | #E63B26 | Errors, alerts, destructive actions |
| Red Light | #F4695A | Hover states on red elements |
| White | #FFFFFF | Card backgrounds, primary light surface |
| Light Gray | #F5F5F8 | Main content area background |
| Medium Gray | #E2E4EA | Borders, dividers |
| Text Gray | #6B7080 | Secondary text, captions |
| Success Green | #22C55E | Completed/implemented status |
| Info Blue | #3B82F6 | In-progress/approved status |

---

## Website / Application Style

Simple and clear. Clean rather than messy.

Technology and innovation. Robotics. Space.

### Style Principles for The Round Table

1. **Dark sidebar, light content**: The sidebar uses the Dark Blue (#080A24) background with the Aurora logo and orange accent for active navigation items. The main content area uses Light Gray (#F5F5F8) with white cards.

2. **Tech-forward aesthetic**: Clean lines, generous whitespace, subtle shadows. The space/tech theme from Aurora Firmware carries through in the dark sidebar and the crisp, modern UI.

3. **Gradient as signature**: The red-to-orange 45-degree gradient can be used sparingly for visual impact - e.g., the app header accent line, loading bars, or the "Summon the Round Table" button.

4. **Agent identity**: Each agent card uses the Dark Blue background with Orange accent text for their role title, maintaining brand consistency across the boardroom interface.

---

## Logo Assets

### Available Formats

Each variant is available in two format directories:

- `Logo Exportado/Web/SVG/` - Vector SVG files (preferred for web, scalable)
- `Logo Exportado/Web/PNG/` - Raster @2x PNG files (fallback)
- `Logo Exportado/Impresion/SVG/` - Print-quality vector SVG files
- `Logo Exportado/Impresion/PNG/` - Print-quality @2x PNG files

### Logo Variants

The logo consists of two parts: the **icon** (a rounded square containing a triangle and circle) and the **wordmark** ("AURORA" in Bruno Ace, "FIRMWARE" in Josefin Sans).

| # | Variant | Filename | Icon | Text | Background | Best For |
|---|---------|----------|------|------|------------|----------|
| 1 | **Principal** | `Aurora Firmware-Principal` | Gradient (red→orange) | Dark Blue (#080A24) | Opaque white | Light surfaces, documents |
| 2 | **Principal sin fondo** | `Aurora Firmware-Principal sin fondo` | Gradient (red→orange) | Dark Blue (#080A24) | Transparent | Light backgrounds, overlays on images |
| 3 | **Principal sin fondo copia** | `Aurora Firmware-Principal sin fondo copia` | Gradient (red→orange) | White | Transparent | Dark backgrounds (keeps the colorful icon, white text readable on dark) |
| 4 | **Blanco** | `Aurora Firmware-Blanco` | White | White | Transparent | Dark backgrounds, monochrome use |
| 5 | **Secundario** | `Aurora Firmware-Secundario` | White | White | Dark Blue (#080A24) rounded rectangle | Standalone use, app icons, social media |

### Logo Description

The icon is a rounded square with a red-to-orange gradient fill (45 degrees from bottom-left). Inside, a triangle points to the upper-right corner and a circle sits in the lower-left area - both are cut out (transparent/background color). Below the icon, "AURORA" is set in Bruno Ace and "FIRMWARE" in Josefin Sans.

### Usage in The Round Table

| Location | Variant | File | Rationale |
|----------|---------|------|-----------|
| **Sidebar header** | Blanco (#4) | `Aurora Firmware-Blanco.svg` | White monochrome on Dark Blue (#080A24) sidebar keeps it clean |
| **Favicon / PWA icon** | Secundario (#5) | `Aurora Firmware-Secundario.svg` | Self-contained with dark background, works at small sizes |
| **Loading / splash screen** | Principal sin fondo copia (#3) | `Aurora Firmware-Principal sin fondo copia.svg` | Gradient icon provides color pop on Dark Blue background, white text is legible |
| **Login page (light bg)** | Principal sin fondo (#2) | `Aurora Firmware-Principal sin fondo.svg` | Full color logo on light surface |
| **Open Graph / social** | Secundario (#5) | `Aurora Firmware-Secundario.png` | Self-contained, works without background control |

---

## Background Images

Available in `web_pictures/`:

| File | Description | Suggested Usage |
|------|-------------|-----------------|
| `home_banner.jpg` | Tech workspace with developers at screens | Could be used as login/landing page hero |
| `footer_background.jpg` | Abstract dark tech network/circuit pattern | Dashboard background accent, or card header background |
| `dev_in_space_512_1024.jpg` | Developer in space themed image | About/info page, or empty state illustration |
| `Background-JobOffers.jpg` | Job-related background | Not directly applicable to The Round Table |
