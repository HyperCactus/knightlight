# Local interface fonts

Knightlight bundles DM Sans (variable weight) and DM Serif Display (regular and italic) so startup does not depend on a remote font service.

Upstream source: [Google Fonts](https://github.com/google/fonts), directories `ofl/dmsans` and `ofl/dmserifdisplay`. These WOFF2 files were generated from the upstream TTFs with fontTools and subset for Latin interface text. Other characters use the interface's system-font fallback.

The original copyright and SIL Open Font License 1.1 texts are retained in `DM-Sans-OFL.txt` and `DM-Serif-Display-OFL.txt`. These fonts are separate from Knightlight's Apache 2.0 source licence.
