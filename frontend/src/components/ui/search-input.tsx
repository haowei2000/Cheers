import { forwardRef } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  InputWithLeadingIcon,
  type InputWithLeadingIconProps,
} from "./input-with-leading-icon";

export interface SearchInputProps
  extends Omit<InputWithLeadingIconProps, "leading" | "type"> {
  "aria-label": string;
}

/** Semantic search field with registered icon, geometry, and input styling. */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, ...props }, ref) => (
    <InputWithLeadingIcon
      {...props}
      ref={ref}
      type="search"
      leading={<Search />}
      className={cn("[&::-webkit-search-cancel-button]:appearance-none", className)}
    />
  ),
);
SearchInput.displayName = "SearchInput";
