# Editorial Correspondence — build plan (60 components, html)

Build in this order; it is a topological sort, so everything a component
composes already exists when you reach it. Tick items off as you finish
them — this file plus `manifest.json` is what lets a later pass resume.
Full spec for each component (states, a11y contract, notes) is in the
skill's `assets/catalog.json`.

### Tier 0 — Primitives — carry the style directly, depend on nothing. Build first: every later tier inherits their decisions.

- [x] `icon` **Icon** → `components/icon.css` · deps: — · 3 variants, 2 states
- [x] `image` **Image** → `components/image.css` · deps: — · 4 variants, 3 states
- [x] `avatar` **Avatar** → `components/avatar.css` · deps: image, icon · 5 variants, 3 states
- [x] `badge` **Badge** → `components/badge.css` · deps: icon · 9 variants, 3 states
- [x] `heading` **Heading** → `components/heading.css` · deps: — · 3 variants, 0 states
- [x] `label` **Label** → `components/label.css` · deps: — · 4 variants, 3 states
- [x] `link` **Link** → `components/link.css` · deps: icon · 4 variants, 5 states
- [x] `list` **List** → `components/list.css` · deps: icon · 5 variants, 0 states
- [x] `progress-bar` **Progress bar** → `components/progress-bar.css` · deps: — · 4 variants, 4 states
- [x] `quote` **Quote** → `components/quote.css` · deps: — · 3 variants, 0 states
- [x] `separator` **Separator** → `components/separator.css` · deps: — · 3 variants, 0 states
- [x] `skeleton` **Skeleton** → `components/skeleton.css` · deps: — · 4 variants, 2 states
- [x] `spinner` **Spinner** → `components/spinner.css` · deps: — · 4 variants, 1 states
- [x] `stack` **Stack** → `components/stack.css` · deps: — · 4 variants, 0 states
- [x] `visually-hidden` **Visually hidden** → `components/visually-hidden.css` · deps: — · 2 variants, 2 states

### Tier 1 — Controls — single interactive inputs. Compose tier 0.

- [x] `button` **Button** → `components/button.css` · deps: icon, spinner · 8 variants, 6 states
- [x] `checkbox` **Checkbox** → `components/checkbox.css` · deps: icon, label · 4 variants, 6 states
- [x] `fieldset` **Fieldset** → `components/fieldset.css` · deps: label, separator, heading · 4 variants, 3 states
- [x] `text-input` **Text input** → `components/text-input.css` · deps: label · 5 variants, 8 states
- [x] `date-input` **Date input** → `components/date-input.css` · deps: text-input, label, fieldset · 3 variants, 5 states
- [x] `file` **File** → `components/file.css` · deps: icon, link, badge, progress-bar · 5 variants, 4 states
- [x] `file-upload` **File upload** → `components/file-upload.css` · deps: button, icon, progress-bar, file · 4 variants, 6 states
- [x] `progress-indicator` **Progress indicator** → `components/progress-indicator.css` · deps: icon, separator, heading · 5 variants, 5 states
- [x] `radio-button` **Radio button** → `components/radio-button.css` · deps: icon, label, fieldset · 4 variants, 5 states
- [x] `rating` **Rating** → `components/rating.css` · deps: icon · 5 variants, 4 states
- [x] `search-input` **Search input** → `components/search-input.css` · deps: text-input, icon, button · 4 variants, 5 states
- [x] `select` **Select** → `components/select.css` · deps: icon, label · 5 variants, 6 states
- [x] `skip-link` **Skip link** → `components/skip-link.css` · deps: link · 2 variants, 2 states
- [x] `slider` **Slider** → `components/slider.css` · deps: label · 5 variants, 4 states
- [x] `stepper` **Stepper** → `components/stepper.css` · deps: button, text-input, icon · 3 variants, 5 states
- [x] `textarea` **Textarea** → `components/textarea.css` · deps: text-input · 4 variants, 5 states
- [x] `toggle` **Toggle** → `components/toggle.css` · deps: label, icon · 4 variants, 5 states

### Tier 2 — Composites — assemblies of controls and primitives.

- [x] `accordion` **Accordion** → `components/accordion.css` · deps: icon, heading, separator · 5 variants, 4 states
- [x] `alert` **Alert** → `components/alert.css` · deps: icon, button, heading, link · 9 variants, 2 states
- [x] `breadcrumbs` **Breadcrumbs** → `components/breadcrumbs.css` · deps: link, icon · 4 variants, 3 states
- [x] `button-group` **Button group** → `components/button-group.css` · deps: button, separator · 5 variants, 3 states
- [x] `card` **Card** → `components/card.css` · deps: heading, image, button, badge, separator · 6 variants, 5 states
- [x] `empty-state` **Empty state** → `components/empty-state.css` · deps: heading, button, icon, image · 5 variants, 0 states
- [x] `form` **Form** → `components/form.css` · deps: fieldset, label, text-input, button, alert · 4 variants, 4 states
- [x] `navigation` **Navigation** → `components/navigation.css` · deps: link, icon, badge, separator · 6 variants, 5 states
- [x] `pagination` **Pagination** → `components/pagination.css` · deps: button, link, select, icon · 5 variants, 5 states
- [x] `segmented-control` **Segmented control** → `components/segmented-control.css` · deps: button, icon · 5 variants, 4 states
- [x] `table` **Table** → `components/table.css` · deps: checkbox, icon, link, badge, button, pagination, skeleton, empty-state · 9 variants, 6 states
- [x] `tabs` **Tabs** → `components/tabs.css` · deps: button, icon, badge, separator · 7 variants, 5 states
- [x] `tree-view` **Tree view** → `components/tree-view.css` · deps: icon, checkbox · 5 variants, 6 states

### Tier 3 — Overlays — anything that escapes normal flow (portal, focus trap, positioning).

- [x] `popover` **Popover** → `components/popover.css` · deps: button, icon, card · 5 variants, 3 states
- [x] `color-picker` **Color picker** → `components/color-picker.css` · deps: popover, text-input, button · 5 variants, 5 states
- [x] `combobox` **Combobox** → `components/combobox.css` · deps: text-input, popover, icon, spinner, badge · 5 variants, 8 states
- [x] `datepicker` **Datepicker** → `components/datepicker.css` · deps: popover, button, icon, date-input, select · 5 variants, 6 states
- [x] `modal` **Modal** → `components/modal.css` · deps: button, icon, heading, separator · 6 variants, 4 states
- [x] `drawer` **Drawer** → `components/drawer.css` · deps: modal, icon, button · 6 variants, 3 states
- [x] `dropdown-menu` **Dropdown menu** → `components/dropdown-menu.css` · deps: popover, icon, separator, badge · 6 variants, 6 states
- [x] `toast` **Toast** → `components/toast.css` · deps: alert, icon, button · 7 variants, 4 states
- [x] `tooltip` **Tooltip** → `components/tooltip.css` · deps: popover · 4 variants, 3 states

### Tier 4 — Page composition — full-width regions and editors.

- [x] `carousel` **Carousel** → `components/carousel.css` · deps: button, icon, image, card · 6 variants, 6 states
- [x] `footer` **Footer** → `components/footer.css` · deps: link, list, separator, heading, icon · 4 variants, 1 states
- [x] `header` **Header** → `components/header.css` · deps: navigation, link, button, avatar, search-input, icon, dropdown-menu, skip-link · 6 variants, 3 states
- [x] `hero` **Hero** → `components/hero.css` · deps: heading, button, image, badge · 5 variants, 1 states
- [x] `rich-text-editor` **Rich text editor** → `components/rich-text-editor.css` · deps: button, button-group, icon, separator, dropdown-menu, tooltip, popover · 5 variants, 5 states
- [x] `video` **Video** → `components/video.css` · deps: button, icon, slider, progress-bar · 5 variants, 6 states
