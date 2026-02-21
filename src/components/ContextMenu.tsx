import type { ReactNode, RefObject } from "react";
import OpenInFullOutlinedIcon from "@mui/icons-material/OpenInFullOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import FileCopyOutlinedIcon from "@mui/icons-material/FileCopyOutlined";
import DriveFileMoveOutlinedIcon from "@mui/icons-material/DriveFileMoveOutlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import ReplayOutlinedIcon from "@mui/icons-material/ReplayOutlined";

export type ContextMenuAction =
  | "open"
  | "copy"
  | "reveal"
  | "retry-import"
  | "retry-thumbnail"
  | "duplicate"
  | "move"
  | "delete";

type ContextMenuProps = {
  open: boolean;
  x: number;
  y: number;
  itemId: string | null;
  canRetryImport?: boolean;
  canRetryThumbnail?: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  onAction: (action: ContextMenuAction, itemId: string) => void;
};

const MENU_WIDTH = 220;
const MENU_HEIGHT = 260;

function ContextMenu({
  open,
  x,
  y,
  itemId,
  canRetryImport = false,
  canRetryThumbnail = false,
  menuRef,
  onAction,
}: ContextMenuProps) {
  if (!open || !itemId) return null;

  const boundedX = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const boundedY = Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT - 8));

  const menuItems: Array<{
    label: string;
    action: ContextMenuAction;
    shortcut?: string;
    danger?: boolean;
    icon: ReactNode;
  }> = [
    { label: "Open", action: "open", shortcut: "Enter", icon: <OpenInFullOutlinedIcon fontSize="inherit" /> },
    { label: "Copy", action: "copy", shortcut: "Ctrl+C", icon: <ContentCopyOutlinedIcon fontSize="inherit" /> },
    { label: "Reveal in folder", action: "reveal", icon: <FolderOpenOutlinedIcon fontSize="inherit" /> },
    ...(canRetryImport
      ? [
          {
            label: "Retry import",
            action: "retry-import",
            icon: <ReplayOutlinedIcon fontSize="inherit" />,
          } as const,
        ]
      : []),
    ...(canRetryThumbnail
      ? [
          {
            label: "Retry thumbnail",
            action: "retry-thumbnail",
            icon: <ReplayOutlinedIcon fontSize="inherit" />,
          } as const,
        ]
      : []),
    { label: "Duplicate", action: "duplicate", icon: <FileCopyOutlinedIcon fontSize="inherit" /> },
    { label: "Move to...", action: "move", icon: <DriveFileMoveOutlinedIcon fontSize="inherit" /> },
    { label: "Delete", action: "delete", danger: true, icon: <DeleteOutlineOutlinedIcon fontSize="inherit" /> },
  ];

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: `${boundedX}px`, top: `${boundedY}px` }}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      {menuItems.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className={`context-menu-item ${item.danger ? "danger" : ""}`}
          onClick={() => onAction(item.action, itemId)}
        >
          <span className="context-menu-icon">{item.icon}</span>
          <span className="context-menu-label">{item.label}</span>
          {item.shortcut && (
            <span className="context-menu-shortcut">{item.shortcut}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export default ContextMenu;
