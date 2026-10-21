import { Lock } from "lucide-react";
import Link from "next/link";

export default function Forbidden() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-sm space-y-3 text-center">
        <Lock className="mx-auto size-8 text-text-muted" aria-hidden />
        <h1 className="text-lg font-semibold">You don&apos;t have access to this page</h1>
        <p className="text-sm text-text-muted">This area is for admins. Ask an admin if you need a change made.</p>
        <Link href="/" className="text-sm text-brand hover:underline">
          Back to the overview
        </Link>
      </div>
    </main>
  );
}
