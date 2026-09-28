import {Preview} from "./Preview";

export const metadata = {title: "Preview"};

/** Dev only: page views on fixture data. /dev/preview/markets?state=open|weekend|paused|loading|error */
export default async function PreviewPage({params, searchParams}: {params: Promise<{page: string}>; searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const {page} = await params;
  const sp = await searchParams;
  return <Preview page={page} state={typeof sp.state === "string" ? sp.state : "open"} />;
}
