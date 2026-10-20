"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__all";

export type FilterDef = { key: string; label: string; options: Array<{ value: string; label: string }> };

/** URL-driven filters: every change updates the query string, so views can be shared and reloaded. */
export function FilterBar({ filters, search, searchPlaceholder = "Search…", pivots = [] }: { filters: FilterDef[]; search?: boolean; searchPlaceholder?: string; pivots?: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");

  const set = (key: string, value: string | null) => {
    const sp = new URLSearchParams(params.toString());
    if (value === null || value === ALL || value === "") sp.delete(key);
    else sp.set(key, value);
    sp.delete("page");
    router.push(sp.size ? `${pathname}?${sp}` : pathname);
  };

  const active = [...filters.map((f) => f.key), ...pivots].filter((k) => params.get(k));

  return (
    <div className="flex flex-wrap items-center gap-2">
      {search && (
        <form
          className="relative"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            set("q", q.trim());
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <Input aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} className="w-56 pl-8" maxLength={100} />
        </form>
      )}
      {filters.map((f) => (
        <Select key={f.key} value={params.get(f.key) ?? ALL} onValueChange={(v) => set(f.key, v)}>
          <SelectTrigger size="sm" className="w-40" aria-label={f.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{f.label}</SelectItem>
            {f.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
      {pivots
        .filter((k) => params.get(k))
        .map((k) => (
          <Button key={k} variant="secondary" size="sm" onClick={() => set(k, null)} aria-label={`Remove ${k} filter`}>
            {k}: <span className="max-w-40 truncate font-mono">{params.get(k)}</span>
            <X aria-hidden />
          </Button>
        ))}
      {active.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const sp = new URLSearchParams();
            const range = params.get("range");
            if (range) sp.set("range", range);
            setQ("");
            router.push(sp.size ? `${pathname}?${sp}` : pathname);
          }}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
