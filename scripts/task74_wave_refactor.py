#!/usr/bin/env python3
"""Task 74: move the three-wave source-order tables from StreamResolver.resolve()
to module scope as exported orderSourcesForRequest() — mechanical move, zero
behavior change. Marker-based (no raw line numbers) with hard assertions."""
import re, sys

PATH = '/home/z/my-project/phoenix-analysis/src/utils/StreamResolver.js'
src = open(PATH, encoding='utf-8').read()

START = '    // ─── THREE-WAVE SCHEDULING (Task 43 — data-driven, production-measured)'
END = '    ).filter(s => isScheduled(s, type));\n'

i = src.index(START)
j = src.index(END) + len(END)
block = src[i:j]
assert block.count('WAVE1_SOURCE_ORDER = [') == 1
assert block.count('WAVE2_SOURCE_IDS = new Set(') == 1
assert block.count('BACKGROUND_ONLY_SOURCE_IDS = new Set(') == 1
assert block.count('ANIME_ONLY_SOURCE_IDS = new Set(') == 1
assert block.count('const sortedSources =') == 1

# Split: everything up to (excluding) the sortedSources construction goes to
# module scope; the sortedSources lines are replaced inside resolve().
tail_marker = '    const sortedSources = [...sources].sort(\n'
k = block.index(tail_marker)
move_part = block[:k]          # tables + waveOf/isScheduled + comments
rest_in_resolve = block[k:]    # sortedSources construction

# De-indent move_part by exactly 4 leading spaces per line (module scope).
lines = []
for ln in move_part.split('\n'):
    if ln.startswith('    '):
        lines.append(ln[4:])
    else:
        lines.append(ln)
moved = '\n'.join(lines).rstrip() + '\n'

# Header note for the moved block (replaces the first line's section title).
moved = moved.replace(
    '// ─── THREE-WAVE SCHEDULING (Task 43 — data-driven, production-measured)',
    '// ─── THREE-WAVE SOURCE ORDER (Task 43 — data-driven, production-measured) ───\n'
    '// Task 74: moved to MODULE scope (was function-scoped inside resolve()) so the\n'
    '// idle Cache-Keeper can import the exact same ordering — single source of\n'
    '// truth, zero drift. resolve() calls orderSourcesForRequest() below.',
    1)

fn = (
    '// Task 74 export: the idle Cache-Keeper warms sources through THIS function so\n'
    '// a keeper pass populates exactly the sources resolve() would schedule for the\n'
    '// same request type (same movie anime-skip, same wave priority). Pure reorder\n'
    '// + filter — identical behavior to the previous function-scoped code.\n'
    'export function orderSourcesForRequest(sources, requestType) {\n'
    '  const isScheduled = (source, type) =>\n'
    '    ANIME_SOURCES_ON_MOVIES || type !== \'movie\' || !ANIME_ONLY_SOURCE_IDS.has(source.id);\n'
    '  const waveOf = (sourceId, type) => {\n'
    '    const w1 = WAVE1_SOURCE_ORDER.indexOf(sourceId);\n'
    '    if (w1 !== -1) return w1; // 0..19 — exact start order within wave 0\n'
    '    if (ANIME_ONLY_SOURCE_IDS.has(sourceId)) return requestType === \'series\' ? 100 : 200;\n'
    '    if (WAVE2_SOURCE_IDS.has(sourceId)) return 100;\n'
    '    if (BACKGROUND_ONLY_SOURCE_IDS.has(sourceId)) return 200;\n'
    '    return 100; // unclassified future sources: medium — get a chance, never starve wave-0\n'
    '  };\n'
    '  return [...sources].sort(\n'
    '    (a, b) => waveOf(a.id, requestType) - waveOf(b.id, requestType)\n'
    '  ).filter(s => isScheduled(s, requestType));\n'
    '}\n\n'
)

resolve_replacement = (
    '    // ─── THREE-WAVE SCHEDULING (Task 43 — data-driven, production-measured) ───\n'
    '    // Task 74: the wave tables + ordering logic live at MODULE scope as the\n'
    '    // exported orderSourcesForRequest() — identical tables, identical order,\n'
    '    // zero behavior change. The idle Cache-Keeper imports the same function so\n'
    '    // a keeper-warmed cache matches exactly what this resolve would schedule.\n'
    '    const sortedSources = orderSourcesForRequest(sources, type);\n'
)

# 1) cut the whole block from resolve() and splice the replacement
src2 = src[:i] + resolve_replacement + src[j:]
# 2) insert the module block before the class declaration
anchor = 'export class StreamResolver {'
assert src2.count(anchor) == 1
src2 = src2.replace(anchor, moved + '\n' + fn + anchor, 1)

# sanity: each table now appears exactly once in the file
for name in ('WAVE1_SOURCE_ORDER = [', 'WAVE2_SOURCE_IDS = new Set(',
             'BACKGROUND_ONLY_SOURCE_IDS = new Set(', 'ANIME_ONLY_SOURCE_IDS = new Set(',
             'export function orderSourcesForRequest('):
    assert src2.count(name) == 1, name
assert src2.count('orderSourcesForRequest(sources, type)') == 1

open(PATH, 'w', encoding='utf-8').write(src2)
print('OK: tables moved to module scope; resolve() now calls orderSourcesForRequest()')
