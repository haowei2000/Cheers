# Source typography

Source Serif 4 supplies the display and reading roles. Files come from Adobe's
official release branch:

- upstream: https://github.com/adobe-fonts/source-serif/tree/release
- variable Web font: `WOFF2/VAR/SourceSerif4Variable-Roman.ttf.woff2`
- native text cuts: `SourceSerif4-Regular.ttf`, `SourceSerif4-Semibold.ttf`
- native display cut: `SourceSerif4Display-Semibold.ttf`
- license: SIL Open Font License 1.1 (`SourceSerif4-OFL.txt`)

Source Sans 3 supplies the Web utility role and is paired with the native
platform sans on iOS and Android:

- upstream: https://github.com/adobe-fonts/source-sans/tree/release
- variable Web font: `WOFF2/VF/SourceSans3VF-Upright.ttf.woff2`
- license: SIL Open Font License 1.1

Source Han Serif CN supplies the Chinese glyphs for both display and reading:

- upstream: https://github.com/adobe-fonts/source-han-serif/tree/release
- native regional variable font: `Variable/TTF/Subset/SourceHanSerifCN-VF.ttf`
- Web regional variable font: `Variable/WOFF2/TTF/Subset/SourceHanSerifCN-VF.ttf.woff2`
- version: 2.003R
- license: SIL Open Font License 1.1 (`SourceHanSerif-OFL.txt`)

The font is self-hosted so the Web PWA and native clients do not depend on a
runtime font CDN. Do not remove the OFL text when redistributing bundled font
files. Text-run resolvers use Source Han Serif CN for Chinese display/reading,
locale-correct native serif for Japanese and Korean, and native sans fallback
for multilingual utility text.
