import { useEffect, useId, useState, type ReactNode } from "react";
import {
  createComponentImplementation,
  useA2uiSurface,
  type ReactCatalogComponent,
} from "@a2ui/react";
import { CommonSchemas } from "@a2ui/web_core/v1_0";
import { z } from "zod";
import {
  A2uiAudioPlayer,
  A2uiIcon,
  A2uiImage,
  A2uiVideo,
  basicCatalog,
  ButtonApi,
  CardApi,
  CheckBoxApi,
  ChoicePickerApi,
  ColumnApi,
  DateTimeInputApi,
  DividerApi,
  ListApi,
  ModalApi,
  RowApi,
  SliderApi,
  TabsApi,
  TextApi,
  TextFieldApi,
} from "@a2ui/web_core/catalogs/basic/v1";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

function useSurfaceDataValue<T = unknown>(raw: unknown, fallback?: T): [T | undefined, (next: T) => void] {
  const surface = useA2uiSurface();
  const path =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? ((raw as Record<string, unknown>)["@path"] as string | undefined) ??
        ((raw as Record<string, unknown>).path as string | undefined)
      : undefined;

  const read = (): T | undefined => {
    if (!path || !surface) return (raw as T | undefined) ?? fallback;
    const val = surface.dataModel.get<T>(path);
    return val !== undefined ? val : fallback;
  };

  const [value, setValue] = useState<T | undefined>(read);

  useEffect(() => {
    setValue(read());
    if (!path || !surface) return;
    const sub = surface.dataModel.subscribe<T>(path, (next) => {
      setValue(next !== undefined ? next : fallback);
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, path, raw]);

  const write = (next: T) => {
    setValue(next);
    if (path && surface) {
      surface.dataModel.set(path, next);
    }
  };

  return [value, write];
}

function childKey(child: unknown, fallback: number): string | number {
  if (typeof child === "string") return child;
  if (child && typeof child === "object" && "id" in child && typeof (child as { id?: unknown }).id === "string") {
    return (child as { id: string }).id;
  }
  return fallback;
}

function CheersNode({ id }: { id: string }): ReactNode {
  const surface = useA2uiSurface();
  const comp = surface?.componentsModel.get(id);
  if (!comp || !surface) return null;
  const p = comp.properties as Record<string, unknown>;

  switch (comp.type) {
    case "Column":
      return <CheersColumnView childrenIds={p.children} />;
    case "Row":
      return <CheersRowView childrenIds={p.children} />;
    case "List":
      return <CheersListView childrenIds={p.children} direction={p.direction as string | undefined} />;
    case "Card":
      return <CheersCardView childId={p.child} />;
    case "Divider":
      return <Separator orientation={p.axis === "vertical" ? "vertical" : "horizontal"} />;
    case "Tabs":
      return <CheersTabsView tabs={p.tabs} />;
    case "Modal":
      return <CheersModalView triggerId={p.trigger} contentId={p.content} />;
    case "Text":
      return <CheersTextView textProp={p.text} variant={p.variant as string | undefined} />;
    case "TextField":
      return (
        <CheersTextFieldView
          labelProp={p.label}
          valueProp={p.value}
          placeholderProp={p.placeholder}
          variant={p.variant as string | undefined}
        />
      );
    case "CheckBox":
      return <CheersCheckBoxView labelProp={p.label} valueProp={p.value} />;
    case "ChoicePicker":
      return (
        <CheersChoicePickerView
          labelProp={p.label}
          valueProp={p.value}
          options={p.options}
          variant={p.variant as string | undefined}
        />
      );
    case "Slider":
      return (
        <CheersSliderView
          labelProp={p.label}
          valueProp={p.value}
          min={typeof p.min === "number" ? p.min : 0}
          max={typeof p.max === "number" ? p.max : 100}
        />
      );
    case "DateTimeInput":
      return (
        <CheersDateTimeInputView
          labelProp={p.label}
          valueProp={p.value}
          enableDate={p.enableDate === undefined ? true : Boolean(p.enableDate)}
          enableTime={Boolean(p.enableTime)}
        />
      );
    case "Button":
      return <CheersButtonView id={id} childId={p.child} actionProp={p.action} />;
    default:
      return null;
  }
}

function renderChild(
  child: unknown,
  buildChild?: (id: string, basePath?: string) => ReactNode,
): ReactNode {
  if (!child) return null;
  if (typeof child === "object" && "type" in child && "properties" in child && buildChild) {
    return buildChild(child as unknown as string);
  }
  if (typeof child === "string") {
    return <CheersNode id={child} />;
  }
  if (typeof child === "object" && "id" in child && typeof (child as { id?: unknown }).id === "string") {
    return <CheersNode id={(child as { id: string }).id} />;
  }
  return null;
}

function renderChildren(
  children: unknown,
  buildChild?: (id: string, basePath?: string) => ReactNode,
): ReactNode {
  if (!Array.isArray(children)) return null;
  return children.map((child, idx) => (
    // design-system-exempt: A2UI generic layout child wrapper
    <div key={childKey(child, idx)} className="min-w-0">
      {renderChild(child, buildChild)}
    </div>
  ));
}

function CheersColumnView({ childrenIds, buildChild }: { childrenIds: unknown; buildChild?: (id: string, basePath?: string) => ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-3">{renderChildren(childrenIds, buildChild)}</div>;
}

function CheersRowView({ childrenIds, buildChild }: { childrenIds: unknown; buildChild?: (id: string, basePath?: string) => ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-3">{renderChildren(childrenIds, buildChild)}</div>;
}

function CheersListView({ childrenIds, direction, buildChild }: { childrenIds: unknown; direction?: string; buildChild?: (id: string, basePath?: string) => ReactNode }) {
  return (
    <div className={direction === "horizontal" ? "flex min-w-0 flex-wrap items-start gap-3" : "flex min-w-0 flex-col gap-3"}>
      {renderChildren(childrenIds, buildChild)}
    </div>
  );
}

function CheersCardView({ childId, buildChild }: { childId: unknown; buildChild?: (id: string, basePath?: string) => ReactNode }) {
  return <div className="min-w-0 rounded-sm bg-panel p-4">{renderChild(childId, buildChild)}</div>;
}

function CheersTabsView({ tabs, buildChild }: { tabs: unknown; buildChild?: (id: string, basePath?: string) => ReactNode }) {
  const [active, setActive] = useState(0);
  const list = Array.isArray(tabs) ? (tabs as Array<{ title?: unknown; child?: unknown }>) : [];
  const current = list[active] ?? list[0];
  return (
    <div className="min-w-0 space-y-3">
      <div role="tablist" className="flex min-w-0 flex-wrap gap-1 border-b border-edge pb-2">
        {list.map((tab, idx: number) => (
          <Button
            key={idx}
            type="button"
            role="tab"
            aria-selected={idx === active}
            variant={idx === active ? "secondary" : "ghost"}
            controlSize="compact"
            onClick={() => setActive(idx)}
          >
            {String(tab.title ?? `Tab ${idx + 1}`)}
          </Button>
        ))}
      </div>
      {current?.child ? <div className="min-w-0">{renderChild(current.child, buildChild)}</div> : null}
    </div>
  );
}

function CheersModalView({ triggerId, contentId, buildChild }: { triggerId: unknown; contentId: unknown; buildChild?: (id: string, basePath?: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      <div onClick={() => setOpen(true)} className="inline-block">
        {renderChild(triggerId, buildChild)}
      </div>
      {open && (
        <div role="dialog" aria-modal="true" className="mt-3 space-y-3 rounded-sm bg-panel p-4 shadow-md">
          {renderChild(contentId, buildChild)}
          <div className="flex justify-end">
            <ActionButton
              context="dialog"
              action="cancel"
              controlSize="compact"
              accessibleLabel="Close dialog"
              onClick={() => setOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function CheersTextView({ textProp, variant }: { textProp: unknown; variant?: string }) {
  const [text] = useSurfaceDataValue<string>(textProp, "");
  const isCaption = variant === "caption";
  return (
    <p
      className={
        isCaption
          ? "whitespace-pre-wrap break-words font-utility text-body-secondary"
          : "whitespace-pre-wrap break-words font-reading text-regular leading-reading text-content-primary"
      }
    >
      {text ?? ""}
    </p>
  );
}

function CheersTextFieldView({
  labelProp,
  valueProp,
  placeholderProp,
  variant,
}: {
  labelProp: unknown;
  valueProp: unknown;
  placeholderProp?: unknown;
  variant?: string;
}) {
  const id = useId();
  const [label] = useSurfaceDataValue<string>(labelProp, "Text input");
  const [placeholder] = useSurfaceDataValue<string>(placeholderProp, "");
  const [value, setValue] = useSurfaceDataValue<string>(valueProp, "");
  return (
    <Field htmlFor={id} label={label || "Text input"} className="min-w-0">
      <Input
        id={id}
        variant="plain"
        type={variant === "number" ? "number" : variant === "obscured" ? "password" : "text"}
        placeholder={placeholder || undefined}
        value={value ?? ""}
        onChange={(e) => setValue(e.target.value)}
      />
    </Field>
  );
}

function CheersCheckBoxView({ labelProp, valueProp }: { labelProp: unknown; valueProp: unknown }) {
  const [label] = useSurfaceDataValue<string>(labelProp, "Option");
  const [checked, setChecked] = useSurfaceDataValue<boolean>(valueProp, false);
  return (
    <CheckboxField
      label={label || "Option"}
      checked={Boolean(checked)}
      onChange={(e) => setChecked(e.target.checked)}
    />
  );
}

function CheersChoicePickerView({
  labelProp,
  valueProp,
  options,
  variant,
}: {
  labelProp: unknown;
  valueProp: unknown;
  options: unknown;
  variant?: string;
}) {
  const [label] = useSurfaceDataValue<string>(labelProp, "");
  const [selected, setSelected] = useSurfaceDataValue<string[]>(valueProp, []);
  const list = Array.isArray(options) ? (options as Array<{ label?: unknown; value?: unknown }>) : [];
  const current = Array.isArray(selected) ? selected : [];
  const single = variant === "mutuallyExclusive";
  const toggle = (val: string, checked: boolean) => {
    if (single) {
      setSelected(checked ? [val] : []);
      return;
    }
    setSelected(checked ? Array.from(new Set([...current, val])) : current.filter((item) => item !== val));
  };
  return (
    <fieldset className="min-w-0 space-y-2">
      {label && <legend className="font-utility text-regular font-medium text-content-primary">{label}</legend>}
      <div className="flex flex-col gap-2">
        {list.map((opt) => {
          const val = String(opt.value ?? "");
          return (
            <CheckboxField
              key={val}
              label={String(opt.label ?? val)}
              checked={current.includes(val)}
              onChange={(e) => toggle(val, e.target.checked)}
            />
          );
        })}
      </div>
    </fieldset>
  );
}

function CheersSliderView({ labelProp, valueProp, min, max }: { labelProp: unknown; valueProp: unknown; min: number; max: number }) {
  const id = useId();
  const [label] = useSurfaceDataValue<string>(labelProp, "Value");
  const [value, setValue] = useSurfaceDataValue<number>(valueProp, min);
  const num = typeof value === "number" ? value : min;
  return (
    <Field htmlFor={id} label={`${label || "Value"}: ${num}`} className="min-w-0">
      <Input
        id={id}
        variant="plain"
        type="range"
        min={min}
        max={max}
        value={String(num)}
        onChange={(e) => setValue(Number(e.target.value))}
      />
    </Field>
  );
}

function normalizeDateTimeValue(raw: string | undefined, enableDate: boolean, enableTime: boolean): string {
  if (!raw) return "";
  if (enableDate && enableTime) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !raw.endsWith("Z") && !/[+-]\d{2}:\d{2}$/.test(raw)) {
      return raw.slice(0, 16);
    }
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      const shifted = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
      return shifted.toISOString().slice(0, 16);
    }
    return raw.slice(0, 16);
  }
  if (enableDate) return raw.slice(0, 10);
  const timeMatch = /(\d{2}:\d{2})/.exec(raw);
  return timeMatch ? timeMatch[1] : raw.slice(0, 5);
}

function CheersDateTimeInputView({
  labelProp,
  valueProp,
  enableDate,
  enableTime,
}: {
  labelProp: unknown;
  valueProp: unknown;
  enableDate: boolean;
  enableTime: boolean;
}) {
  const id = useId();
  const [label] = useSurfaceDataValue<string>(labelProp, "Date / time");
  const [value, setValue] = useSurfaceDataValue<string>(valueProp, "");
  const type = enableDate && enableTime ? "datetime-local" : enableTime ? "time" : "date";
  const normalized = normalizeDateTimeValue(value, enableDate, enableTime);
  return (
    <Field htmlFor={id} label={label || "Date / time"} className="min-w-0">
      <Input
        id={id}
        variant="plain"
        type={type}
        value={normalized}
        onChange={(e) => setValue(e.target.value)}
      />
    </Field>
  );
}

function CheersButtonView({
  id,
  childId,
  actionProp,
  onInvoke,
  buildChild,
}: {
  id: string;
  childId: unknown;
  actionProp?: unknown;
  onInvoke?: () => void;
  buildChild?: (id: string, basePath?: string) => ReactNode;
}) {
  const surface = useA2uiSurface();
  const handleClick = () => {
    if (onInvoke) {
      onInvoke();
      return;
    }
    if (surface && actionProp && typeof actionProp === "object" && "event" in actionProp) {
      const ev = (actionProp as { event?: { name?: string; context?: Record<string, unknown> } }).event;
      if (ev?.name) {
        void surface.dispatchAction({ name: ev.name, context: ev.context ?? {} }, id);
      }
    }
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {renderChild(childId, buildChild)}
      <ActionButton
        context="resourceCard"
        action="request"
        controlSize="compact"
        accessibleLabel="Run action"
        onClick={handleClick}
      />
    </div>
  );
}

const CheersColumnApi = { ...ColumnApi, schema: ColumnApi.schema.extend({ children: CommonSchemas.ChildList }) };
const CheersRowApi = { ...RowApi, schema: RowApi.schema.extend({ children: CommonSchemas.ChildList }) };
const CheersListApi = { ...ListApi, schema: ListApi.schema.extend({ children: CommonSchemas.ChildList }) };
const CheersCardApi = { ...CardApi, schema: CardApi.schema.extend({ child: CommonSchemas.ComponentId }) };
const CheersTabsApi = {
  ...TabsApi,
  schema: TabsApi.schema.extend({
    tabs: z.array(z.object({ title: CommonSchemas.DynamicString, child: CommonSchemas.ComponentId })),
  }),
};
const CheersModalApi = {
  ...ModalApi,
  schema: ModalApi.schema.extend({ trigger: CommonSchemas.ComponentId, content: CommonSchemas.ComponentId }),
};
const CheersButtonApi = { ...ButtonApi, schema: ButtonApi.schema.extend({ child: CommonSchemas.ComponentId }) };

const CheersColumn = createComponentImplementation(CheersColumnApi, ({ props, buildChild }) => (
  <CheersColumnView childrenIds={props.children} buildChild={buildChild} />
));
const CheersRow = createComponentImplementation(CheersRowApi, ({ props, buildChild }) => (
  <CheersRowView childrenIds={props.children} buildChild={buildChild} />
));
const CheersList = createComponentImplementation(CheersListApi, ({ props, buildChild }) => (
  <CheersListView childrenIds={props.children} direction={props.direction} buildChild={buildChild} />
));
const CheersCard = createComponentImplementation(CheersCardApi, ({ props, buildChild }) => (
  <CheersCardView childId={props.child} buildChild={buildChild} />
));
const CheersDivider = createComponentImplementation(DividerApi, ({ props }) => (
  <Separator orientation={props.axis === "vertical" ? "vertical" : "horizontal"} />
));
const CheersTabs = createComponentImplementation(CheersTabsApi, ({ props, buildChild }) => (
  <CheersTabsView tabs={props.tabs} buildChild={buildChild} />
));
const CheersModal = createComponentImplementation(CheersModalApi, ({ props, buildChild }) => (
  <CheersModalView triggerId={props.trigger} contentId={props.content} buildChild={buildChild} />
));
const CheersText = createComponentImplementation(TextApi, ({ props }) => (
  <CheersTextView textProp={props.text} variant={props.variant} />
));
const CheersTextField = createComponentImplementation(TextFieldApi, ({ props }) => (
  <CheersTextFieldView
    labelProp={props.label}
    valueProp={props.value}
    placeholderProp={props.placeholder}
    variant={props.variant}
  />
));
const CheersCheckBox = createComponentImplementation(CheckBoxApi, ({ props }) => (
  <CheersCheckBoxView labelProp={props.label} valueProp={props.value} />
));
const CheersChoicePicker = createComponentImplementation(ChoicePickerApi, ({ props }) => (
  <CheersChoicePickerView
    labelProp={props.label}
    valueProp={props.value}
    options={props.options}
    variant={props.variant}
  />
));
const CheersSlider = createComponentImplementation(SliderApi, ({ props }) => (
  <CheersSliderView
    labelProp={props.label}
    valueProp={props.value}
    min={props.min ?? 0}
    max={props.max ?? 100}
  />
));
const CheersDateTimeInput = createComponentImplementation(DateTimeInputApi, ({ props }) => (
  <CheersDateTimeInputView
    labelProp={props.label}
    valueProp={props.value}
    enableDate={props.enableDate === undefined ? true : Boolean(props.enableDate)}
    enableTime={Boolean(props.enableTime)}
  />
));
const CheersButton = createComponentImplementation(CheersButtonApi, ({ props, buildChild }) => (
  <CheersButtonView
    id="button"
    childId={props.child}
    onInvoke={() => props.action?.()}
    buildChild={buildChild}
  />
));

/** Google A2UI 1.0 Basic Catalog backed by Cheers design-system React components. */
export const cheersBasicCatalog = basicCatalog.copyWith<ReactCatalogComponent>({
  components: [
    CheersText,
    A2uiImage,
    A2uiIcon,
    A2uiVideo,
    A2uiAudioPlayer,
    CheersRow,
    CheersColumn,
    CheersList,
    CheersCard,
    CheersTabs,
    CheersModal,
    CheersDivider,
    CheersButton,
    CheersTextField,
    CheersCheckBox,
    CheersChoicePicker,
    CheersSlider,
    CheersDateTimeInput,
  ],
});
