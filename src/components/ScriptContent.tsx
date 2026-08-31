import type { Narrative, TimelineEntry } from "@/core/script/v2/schema";

export function NarrativeBlocks({ blocks, className = "" }: { blocks: Narrative; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {blocks.map((block, index) => {
        if (block.type === "paragraph") return <p key={index}>{block.text}</p>;
        if (block.type === "quote") {
          return (
            <blockquote key={index} className="border-l-2 border-gold-400/40 pl-3 text-paper-400">
              <p>{block.text}</p>
              {block.attribution && <cite className="mt-1 block text-xs not-italic text-paper-500">——{block.attribution}</cite>}
            </blockquote>
          );
        }
        const List = block.style === "ordered" ? "ol" : "ul";
        return (
          <List key={index} className={`${block.style === "ordered" ? "list-decimal" : "list-disc"} space-y-1 pl-5`}>
            {block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}
          </List>
        );
      })}
    </div>
  );
}

type TimelineLike = Pick<TimelineEntry, "id" | "time" | "title" | "content" | "locationId" | "clueIds">;

export function TimelineList({ entries, locations, className = "" }: { entries: TimelineLike[]; locations?: Map<string, string>; className?: string }) {
  return (
    <ol className={`space-y-3 ${className}`}>
      {entries.map((entry) => (
        <li key={entry.id} className="relative grid grid-cols-[5.75rem_minmax(0,1fr)] gap-2.5">
          <div className="pt-0.5 text-right text-xs font-semibold tabular-nums text-gold-400">{entry.time.display}</div>
          <div className="min-w-0 border-l border-gold-400/20 pl-3 text-paper-300">
            <p className="font-medium text-paper-100">{entry.title}</p>
            {(entry.locationId && locations?.get(entry.locationId)) && <p className="mt-0.5 text-[11px] text-paper-500">{locations.get(entry.locationId)}</p>}
            <NarrativeBlocks blocks={entry.content} className="mt-1 leading-relaxed" />
          </div>
        </li>
      ))}
    </ol>
  );
}
