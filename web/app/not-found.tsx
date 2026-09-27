import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card mx-auto max-w-md p-6 text-center">
      <h1 className="text-xl font-bold">Not found</h1>
      <Link href="/" className="mt-3 inline-block underline">
        Back to markets
      </Link>
    </div>
  );
}
