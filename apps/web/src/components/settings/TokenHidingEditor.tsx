import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, EyeOff, Loader2 } from "lucide-react";
import type { Notebook } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface TokenHidingEditorProps {
  tokenId: string;
  notebooks: Notebook[];
}

interface NotebookNode {
  notebook: Notebook;
  children: NotebookNode[];
}

/** Build a tree from flat notebook list using parent_id. */
function buildTree(notebooks: Notebook[]): NotebookNode[] {
  const byId = new Map(notebooks.map((nb) => [nb.id, nb]));
  const childrenMap = new Map<string | null, Notebook[]>();

  for (const nb of notebooks) {
    const parentKey = nb.parentId ?? null;
    if (!childrenMap.has(parentKey)) childrenMap.set(parentKey, []);
    childrenMap.get(parentKey)!.push(nb);
  }

  const buildNodes = (parentId: string | null): NotebookNode[] => {
    const children = childrenMap.get(parentId) ?? [];
    return children
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name))
      .map((nb) => ({
        notebook: nb,
        children: buildNodes(nb.id),
      }));
  };

  return buildNodes(null);
}

/** Collect all descendant notebook IDs (including self). */
function collectDescendants(node: NotebookNode): string[] {
  return [node.notebook.id, ...node.children.flatMap(collectDescendants)];
}

const NotebookTreeItem = ({
  node,
  hiddenIds,
  onToggle,
  level,
}: {
  node: NotebookNode;
  hiddenIds: Set<string>;
  onToggle: (ids: string[], checked: boolean) => void;
  level: number;
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(level < 1);
  const descendantIds = collectDescendants(node);
  const hiddenCount = descendantIds.filter((id) => hiddenIds.has(id)).length;
  const isFullyHidden = descendantIds.every((id) => hiddenIds.has(id));
  const isPartiallyHidden = hiddenCount > 0 && !isFullyHidden;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 min-h-11"
        style={{ paddingLeft: `${level * 20 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex h-5 w-5 shrink-0 items-center justify-center text-slate-400 hover:text-slate-600"
            aria-label={expanded ? t("mcp.hiding.collapse") : t("mcp.hiding.expand")}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <Checkbox
          id={`nb-hide-${node.notebook.id}`}
          checked={isFullyHidden ? true : isPartiallyHidden ? "indeterminate" : false}
          onCheckedChange={(checked) => onToggle(descendantIds, checked === true)}
          className="shrink-0"
        />
        <label
          htmlFor={`nb-hide-${node.notebook.id}`}
          className="flex-1 cursor-pointer select-none text-sm text-slate-700"
        >
          {node.notebook.name}
          {hiddenCount > 0 && (
            <span className="ml-2 text-xs text-slate-400">
              ({hiddenCount}/{descendantIds.length} {t("mcp.hiding.hidden")})
            </span>
          )}
        </label>
        {isFullyHidden && (
          <EyeOff className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        )}
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <NotebookTreeItem
              key={child.notebook.id}
              node={child}
              hiddenIds={hiddenIds}
              onToggle={onToggle}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const TokenHidingEditor = ({ tokenId, notebooks }: TokenHidingEditorProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isExpanded, setIsExpanded] = useState(false);

  const hidingQuery = useQuery({
    queryKey: ["token-hiding", tokenId],
    queryFn: () => api.getTokenHiding(tokenId),
    enabled: isExpanded,
  });

  const updateMutation = useMutation({
    mutationFn: (ids: string[]) => api.updateTokenHiding(tokenId, ids),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["token-hiding", tokenId] });
    },
  });

  const hiddenIds = new Set(hidingQuery.data?.hiddenNotebookIds ?? []);
  const tree = buildTree(notebooks);
  const hiddenCount = hiddenIds.size;

  const handleToggle = (ids: string[], checked: boolean) => {
    const current = new Set(hiddenIds);
    if (checked) {
      ids.forEach((id) => current.add(id));
    } else {
      ids.forEach((id) => current.delete(id));
    }
    updateMutation.mutate(Array.from(current));
  };

  if (!isExpanded) {
    return (
      <div className="mt-1">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-xs font-normal text-slate-500 hover:text-slate-700"
                onClick={() => setIsExpanded(true)}
              >
                <EyeOff className="h-3 w-3" />
                {t("mcp.hiding.configure")}
                {hiddenCount > 0 && (
                  <span className="text-slate-400">({hiddenCount})</span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("mcp.hiding.configureTooltip")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <EyeOff className="h-3.5 w-3.5 text-slate-500" />
          <span className="text-xs font-medium text-slate-700">
            {t("mcp.hiding.title")}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-slate-400 hover:text-slate-600"
          onClick={() => setIsExpanded(false)}
        >
          {t("common.close")}
        </Button>
      </div>
      <p className="mb-2 text-xs text-slate-400">
        {t("mcp.hiding.description")}
      </p>
      {hidingQuery.isLoading ? (
        <div className="flex items-center gap-2 py-4 text-xs text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("mcp.hiding.loading")}
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto rounded-md bg-white">
          {tree.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-400">
              {t("mcp.hiding.noNotebooks")}
            </p>
          ) : (
            tree.map((node) => (
              <NotebookTreeItem
                key={node.notebook.id}
                node={node}
                hiddenIds={hiddenIds}
                onToggle={handleToggle}
                level={0}
              />
            ))
          )}
        </div>
      )}
      {updateMutation.isError && (
        <p className="mt-2 text-xs text-rose-500">
          {t("mcp.hiding.updateError")}
        </p>
      )}
    </div>
  );
};
