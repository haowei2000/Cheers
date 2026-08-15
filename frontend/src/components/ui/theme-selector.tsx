import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { ChoiceGroup } from "./choice-button";
import { useTheme, type ThemePreference } from "./theme";

const OPTIONS = [
  { value: "system", label: "System", leading: <Monitor />, description: "Follow your device appearance" },
  { value: "light", label: "Light", leading: <Sun />, description: "Always use the light appearance" },
  { value: "dark", label: "Dark", leading: <Moon />, description: "Always use the dark appearance" },
] as const;

export function ThemeSelector({ className, showStatus = true }: {
  className?: string;
  showStatus?: boolean;
}) {
  const { preference, resolvedTheme, setPreference } = useTheme();
  return (
    <div className={cn("min-w-0", className)}>
      <ChoiceGroup<ThemePreference>
        ariaLabel="Color theme"
        value={preference}
        onChange={setPreference}
        options={OPTIONS}
        className="grid-cols-3 max-sm:grid-cols-1"
      />
      {showStatus && (
        <p className="mt-3 text-compact text-content-muted" aria-live="polite">
          Currently using {resolvedTheme} appearance.
        </p>
      )}
    </div>
  );
}
