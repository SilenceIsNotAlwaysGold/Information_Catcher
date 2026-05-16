"use client";

/**
 * DataTable — 列表统一外壳。
 *
 * 不重新实现表格逻辑，包一层 NextUI Table 让样式（hover、间距、对齐、暗色）一致。
 * 业务页可以直接传 columns + rows，也可以传 children 自己组装。
 *
 * 不支持的复杂场景（无限滚动、列拖拽 …）请直接用 NextUI 原生 Table。
 */
import { Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from "@nextui-org/table";
import type { ReactNode } from "react";

export type Column<T> = {
  key: string;
  label: ReactNode;
  /** 单元格渲染：默认取 row[key] */
  render?: (row: T) => ReactNode;
  align?: "start" | "center" | "end";
  /** 列宽提示（CSS string，比如 "120px" / "1fr" / "20%"） */
  width?: string;
};

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  /** 行点击 */
  onRowClick?: (row: T) => void;
  /** 空状态 */
  empty?: ReactNode;
  /** 行的 key 提取器；默认 row.id */
  rowKey?: (row: T) => string | number;
  /** 紧凑模式 */
  dense?: boolean;
  /** 标题区 */
  ariaLabel?: string;
};

export function DataTable<T extends Record<string, any>>({
  columns, rows, onRowClick, empty, rowKey, dense, ariaLabel,
}: Props<T>) {
  return (
    <Table
      aria-label={ariaLabel || "data table"}
      removeWrapper
      isStriped={false}
      classNames={{
        th: `bg-default-50 dark:bg-default-100/30 text-default-600 text-xs font-medium uppercase tracking-wide ${dense ? "py-2" : "py-3"}`,
        td: `${dense ? "py-2" : "py-3"} text-sm`,
        tr: `border-b border-divider last:border-none ${onRowClick ? "cursor-pointer hover:bg-default-50 dark:hover:bg-default-100/30" : ""}`,
      }}
    >
      <TableHeader columns={columns}>
        {(col) => (
          <TableColumn
            key={col.key}
            align={col.align || "start"}
            style={col.width ? { width: col.width } : undefined}
          >
            {col.label}
          </TableColumn>
        )}
      </TableHeader>
      <TableBody emptyContent={empty || "暂无数据"}>
        {rows.map((row) => (
          <TableRow
            key={rowKey ? rowKey(row) : (row.id ?? Math.random())}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {columns.map((col) => (
              <TableCell key={col.key}>
                {col.render ? col.render(row) : row[col.key] ?? ""}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
