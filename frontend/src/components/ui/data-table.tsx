import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { controlIconClasses } from "./control-size";
import { ControlTrigger } from "./control-trigger";
import { EmptyState } from "./empty-state";
import { Skeleton } from "./skeleton";

export type DataTableAlign = "left" | "center" | "right";
export type DataTableSortDirection = "ascending" | "descending";
export interface DataTableSort {
  columnId: string;
  direction: DataTableSortDirection;
}

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Supplying a sort value makes the heading keyboard-sortable. */
  sortValue?: (row: Row) => string | number | null | undefined;
  align?: DataTableAlign;
  className?: string;
  headerClassName?: string;
}

const alignClasses: Record<DataTableAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function compareValues(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

export function sortDataTableRows<Row>(
  rows: Row[],
  columns: DataTableColumn<Row>[],
  sort: DataTableSort | null,
): Row[] {
  if (!sort) return rows;
  const column = columns.find((candidate) => candidate.id === sort.columnId);
  if (!column?.sortValue) return rows;
  const direction = sort.direction === "ascending" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = column.sortValue?.(a.row);
      const right = column.sortValue?.(b.row);
      if (left == null && right == null) return a.index - b.index;
      if (left == null) return 1;
      if (right == null) return -1;
      const compared = compareValues(left, right);
      return compared === 0 ? a.index - b.index : compared * direction;
    })
    .map(({ row }) => row);
}

export function DataTable<Row>({
  label,
  columns,
  rows,
  getRowKey,
  initialSort = null,
  loading = false,
  loadingRows = 3,
  emptyTitle = "No data yet",
  emptyHint,
  emptyIcon,
  rowActions,
  actionsLabel = "Actions",
  rowClassName,
  className,
}: {
  label: string;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row, index: number) => string;
  initialSort?: DataTableSort | null;
  loading?: boolean;
  loadingRows?: number;
  emptyTitle?: ReactNode;
  emptyHint?: ReactNode;
  emptyIcon?: ComponentType<{ className?: string }>;
  rowActions?: (row: Row) => ReactNode;
  actionsLabel?: string;
  rowClassName?: (row: Row) => string | undefined;
  className?: string;
}) {
  const [sort, setSort] = useState<DataTableSort | null>(initialSort);
  const sortedRows = useMemo(() => sortDataTableRows(rows, columns, sort), [columns, rows, sort]);
  const columnCount = columns.length + (rowActions ? 1 : 0);

  const toggleSort = (columnId: string) => {
    setSort((current) => current?.columnId === columnId
      ? { columnId, direction: current.direction === "ascending" ? "descending" : "ascending" }
      : { columnId, direction: "ascending" });
  };

  return (
    <div className={cn("min-w-0 overflow-x-auto", className)}>
      <table className="w-full border-collapse font-utility text-compact">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-control text-content-muted">
            {columns.map((column) => {
              const activeSort = sort?.columnId === column.id ? sort.direction : undefined;
              const align = column.align ?? "left";
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={activeSort ?? (column.sortValue ? "none" : undefined)}
                  className={cn("font-normal", alignClasses[align], column.headerClassName)}
                >
                  {column.sortValue ? (
                    <ControlTrigger
                      controlSize="compact"
                      controlWidth="content"
                      selected={Boolean(activeSort)}
                      aria-label={`Sort by ${typeof column.header === "string" ? column.header : column.id}`}
                      onClick={() => toggleSort(column.id)}
                      className={cn("gap-1", align === "right" && "ml-auto", align === "center" && "mx-auto")}
                    >
                      <span>{column.header}</span>
                      {activeSort === "ascending" ? (
                        <ArrowUp className={controlIconClasses.compact} aria-hidden="true" />
                      ) : activeSort === "descending" ? (
                        <ArrowDown className={controlIconClasses.compact} aria-hidden="true" />
                      ) : (
                        <ArrowUpDown className={controlIconClasses.compact} aria-hidden="true" />
                      )}
                    </ControlTrigger>
                  ) : (
                    <span className="block px-2 py-2">{column.header}</span>
                  )}
                </th>
              );
            })}
            {rowActions && (
              <th scope="col" className="px-2 py-2 text-right font-normal">
                <span className="sr-only">{actionsLabel}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody aria-busy={loading || undefined}>
          {loading ? Array.from({ length: loadingRows }, (_, rowIndex) => (
            <tr key={`loading-${rowIndex}`} className="border-b border-panel">
              {Array.from({ length: columnCount }, (_, columnIndex) => (
                <td key={columnIndex} className="px-2 py-3">
                  <Skeleton />
                </td>
              ))}
            </tr>
          )) : sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columnCount}>
                <EmptyState icon={emptyIcon} title={emptyTitle} hint={emptyHint} />
              </td>
            </tr>
          ) : sortedRows.map((row, index) => (
            <tr
              key={getRowKey(row, index)}
              className={cn(
                "border-b border-panel text-content-secondary transition-colors hover:bg-control/40",
                rowClassName?.(row),
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.id}
                  className={cn("px-2 py-2", alignClasses[column.align ?? "left"], column.className)}
                >
                  {column.cell(row)}
                </td>
              ))}
              {rowActions && <td className="px-2 py-2 text-right">{rowActions(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {loading && <p role="status" className="sr-only">Loading {label}</p>}
    </div>
  );
}
