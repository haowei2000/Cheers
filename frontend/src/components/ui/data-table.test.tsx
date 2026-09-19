import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable, sortDataTableRows, type DataTableColumn } from "./data-table";

type Row = { id: string; name: string; count: number };
const columns: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", cell: (row) => row.name, sortValue: (row) => row.name },
  { id: "count", header: "Count", cell: (row) => row.count, sortValue: (row) => row.count, align: "right" },
];
const rows = [
  { id: "b", name: "Beta", count: 2 },
  { id: "a", name: "Alpha", count: 10 },
];

describe("DataTable", () => {
  it("provides caption, column, sort, and row semantics", () => {
    const markup = renderToStaticMarkup(
      <DataTable label="Usage by bot" columns={columns} rows={rows} getRowKey={(row) => row.id} />,
    );
    expect(markup).toContain("<table");
    expect(markup).toContain("<caption");
    expect(markup).toContain(">Usage by bot</caption>");
    expect(markup).toContain('scope="col"');
    expect(markup).toContain('aria-sort="none"');
    expect(markup).toContain("Sort by Name");
  });

  it("renders loading and empty states inside the table", () => {
    const loading = renderToStaticMarkup(
      <DataTable label="Reports" columns={columns} rows={[]} getRowKey={(row) => row.id} loading loadingRows={2} />,
    );
    const empty = renderToStaticMarkup(
      <DataTable label="Reports" columns={columns} rows={[]} getRowKey={(row) => row.id} emptyTitle="No reports yet" />,
    );
    expect(loading).toContain('aria-busy="true"');
    expect(loading.match(/animate-pulse/g)).toHaveLength(4);
    expect(empty).toContain("No reports yet");
    expect(empty).toContain('colSpan="2"');
  });

  it("sorts values stably in both directions", () => {
    expect(sortDataTableRows(rows, columns, { columnId: "count", direction: "ascending" }).map((row) => row.id)).toEqual(["b", "a"]);
    expect(sortDataTableRows(rows, columns, { columnId: "count", direction: "descending" }).map((row) => row.id)).toEqual(["a", "b"]);
    const withMissing = [...rows, { id: "missing", name: "Missing", count: null as unknown as number }];
    expect(sortDataTableRows(withMissing, columns, { columnId: "count", direction: "descending" }).at(-1)?.id).toBe("missing");
  });

  it("reserves a named column for row actions", () => {
    const markup = renderToStaticMarkup(
      <DataTable
        label="Usage"
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        actionsLabel="Usage actions"
        rowActions={(row) => <button type="button">Inspect {row.name}</button>}
      />,
    );
    expect(markup).toContain("Usage actions");
    expect(markup).toContain("Inspect Alpha");
  });
});
