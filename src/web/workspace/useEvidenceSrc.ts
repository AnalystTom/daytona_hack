import { useEffect, useState } from "react";
import { fetchEvidence } from "./runClient";

// Keep authenticated evidence requests on the run client's access and error path.
export function useEvidenceSrc(src: string) {
  const fromRun = src.startsWith("/api/");
  const [blobUrl, setBlobUrl] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    setError(false);
    if (!fromRun) return;
    let url: string | undefined;
    let live = true;
    void fetchEvidence(src).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setError(true);
        return;
      }
      url = URL.createObjectURL(result.value);
      setBlobUrl(url);
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
      setBlobUrl(undefined);
    };
  }, [src, fromRun]);
  return { src: fromRun ? blobUrl : src, error };
}
