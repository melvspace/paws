import { UploadIcon, ArrowLeftIcon, FolderIcon, FileIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";

interface Entry {
  name: string;
  directory: boolean;
}

export function TeamFiles({
  teamId,
  disabled,
  kind,
}: {
  teamId: string;
  disabled: boolean;
  kind: "files" | "skills";
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [skillName, setSkillName] = useState("");
  const [skill, setSkill] = useState(
    "---\nname: my-skill\ndescription: Describe when to use this skill\n---\n\nInstructions go here.\n",
  );
  const base = `/api/teams/${encodeURIComponent(teamId)}/resources/${kind}`;
  const url = (file: string) => `${base}/${encodeURIComponent(file)}`;

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void fetch(`${base}/${encodeURIComponent(path)}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load shared files.");

        setEntries(await response.json());
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Could not load files.",
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });

    return () => abort.abort();
  }, [base, path, revision]);

  async function upload(file: string, body: Blob | string) {
    setError("");

    try {
      const response = await fetch(url(file), { method: "PUT", body });

      if (!response.ok)
        throw new Error(
          "Could not save file. Files can be up to 16 MB; skill files up to 64 KB.",
        );

      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save file.");
    }
  }

  return (
    <section className="team-files" aria-label="Shared resources">
      <div className="team-file-toolbar">
        {path && <span className="team-resource-path">{path}</span>}
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => uploadRef.current?.click()}
        >
          <UploadIcon size={14} />
          Upload
        </Button>
        {path && (
          <Button
            variant="ghost"
            aria-label="Parent folder"
            disabled={disabled}
            onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
          >
            <ArrowLeftIcon size={14} />
          </Button>
        )}
      </div>
      {loading ? (
        <p role="status">Loading…</p>
      ) : (
        <ul>
          {entries.map((entry) => {
            const file = [path, entry.name].filter(Boolean).join("/");

            return (
              <li className="team-file-row" key={entry.name}>
                {entry.directory ? (
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => setPath(file)}
                  >
                    <FolderIcon size={16} />
                    {entry.name}
                  </Button>
                ) : (
                  <a href={url(file)} download={entry.name}>
                    <FileIcon size={16} />
                    {entry.name}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!loading && !entries.length && <p className="team-empty">No {kind}</p>}
      <input
        type="file"
        ref={uploadRef}
        hidden
        aria-label="Upload shared file"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];

          if (file)
            void upload([path, file.name].filter(Boolean).join("/"), file);

          event.target.value = "";
        }}
      />
      {kind === "skills" && (
        <details>
          <summary>New skill</summary>
          <label htmlFor="skill-folder">Skill folder</label>
          <Input
            id="skill-folder"
            value={skillName}
            disabled={disabled}
            onChange={(event) => setSkillName(event.target.value)}
            placeholder="my-skill"
          />
          <label htmlFor="skill-source">SKILL.md</label>
          <Textarea
            id="skill-source"
            value={skill}
            disabled={disabled}
            onChange={(event) => setSkill(event.target.value)}
          />
          <Button
            disabled={disabled || !/^[a-z][a-z0-9-]*$/.test(skillName)}
            onClick={() => void upload(`${skillName}/SKILL.md`, skill)}
          >
            Create skill
          </Button>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
