import { SearchX } from "lucide-react";
import Link from "next/link";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-sm space-y-3 text-center">
        <SearchX className="mx-auto size-8 text-text-muted" aria-hidden />
        <h1 className="text-lg font-semibold">This page does not exist</h1>
        <p className="text-sm text-text-muted">The link may be wrong, or the record was archived by the retention job.</p>
        <Link href="/" className="text-sm text-brand hover:underline">
          Back to the overview
        </Link>
      </div>
    </main>
  );
}
