#!/usr/bin/env python3
"""Patch queue-manager-service.js to fix script placeholder issue."""

with open('/app/dist/features/swarm-orchestration/services/queue-manager-service.js', 'r', encoding='utf-8') as f:
    content = f.read()

print(f"File length: {len(content)}")

changed = False

# Change 1: Replace IMPACT-ASSESSMENT/REMEDIATION-STEPS markdown stubs with scripts/ directory stubs
if 'Pre-create placeholder deliverable files' in content:
    # Find the try block boundaries
    start = content.find('            // Pre-create placeholder deliverable files')
    end = content.find('            } catch(e) { /* non-fatal */ }', start)
    if end > start:
        end += len('            } catch(e) { /* non-fatal */ }')
        old_block = content[start:end]
        new_block = """            // Pre-create scripts/ directory with stub .sh files so worker sees expected structure
            try {
                const scriptsDir = path.join(delivDir, 'scripts');
                fs.mkdirSync(scriptsDir, {recursive: true});
                const shStub = '#!/usr/bin/env bash\\n# STUB: worker must replace with real commands\\nset -euo pipefail\\n';
                ['diagnose.sh', 'remediate.sh', 'rollback.sh'].forEach(fn => {
                    const fp = path.join(scriptsDir, fn);
                    if (!fs.existsSync(fp)) fs.writeFileSync(fp, shStub);
                });
            } catch(e) { /* non-fatal */ }"""
        content = content[:start] + new_block + content[end:]
        print("Change 1 APPLIED: replaced markdown placeholders with script stubs")
        changed = True
    else:
        print("Change 1 FAILED: could not find try block end")
else:
    print("Change 1: 'Pre-create placeholder' not found")

# Change 2: Queue-bot reads scripts first
if "'Read these files:'," in content:
    # Find queue-bot Read these files section
    start2 = content.find("                'Read these files:',")
    end2 = content.find("                '\\n',", start2)
    if end2 < 0:
        end2 = content.find("                '',\n                '## Evaluation Criteria'", start2)

    # Just replace the 4 lines
    old_read = "                'Read these files:',\n"
    old_read_idx = content.find("                'Read these files:',\n")
    if old_read_idx > 0:
        # Find the end of this block (up to empty string '')
        block_end = content.find("                '',\n                '## Evaluation Criteria'", old_read_idx)
        if block_end > old_read_idx:
            old_chunk = content[old_read_idx:block_end]
            print(f"\nOld chunk:\n{repr(old_chunk)}")
            new_chunk = """                '## STEP 1 — Read and verify the scripts FIRST (before reading anything else):',
                'execute_command cat deliverables/scripts/diagnose.sh',
                'execute_command cat deliverables/scripts/remediate.sh',
                'execute_command cat deliverables/scripts/rollback.sh',
                '',
                '⛔ If any script only has the stub line "STUB: worker must replace with real commands" — STOP.',
                '⛔ Write REVISION-REQUIRED immediately. Scripts are MANDATORY. Do not read the RCA yet.',
                '',
                '## STEP 2 — Read the RCA (only after scripts pass):',
                '- deliverables/RCA-REPORT.md (check: OpenSearch data, graph topology, root cause evidence, Prevention section)',
"""
            content = content[:old_read_idx] + new_chunk + content[block_end:]
            print("Change 2 APPLIED: queue-bot reads scripts first")
            changed = True
        else:
            print("Change 2 FAILED: could not find block end")
            # show context
            print(repr(content[old_read_idx:old_read_idx+500]))
    else:
        print("Change 2 FAILED: 'Read these files:' not found at indentation level")
        idx = content.find("Read these files")
        print(f"  Found 'Read these files' at {idx}")
        if idx > 0:
            print(repr(content[idx:idx+200]))
else:
    print("Change 2: 'Read these files:' not found in content")

if changed:
    with open('/app/dist/features/swarm-orchestration/services/queue-manager-service.js', 'w', encoding='utf-8') as f:
        f.write(content)
    print("\nFile saved successfully")
else:
    print("\nNo changes made")

# Verify
with open('/app/dist/features/swarm-orchestration/services/queue-manager-service.js', 'r') as f:
    vc = f.read()
print(f"\nVerification:")
print(f"  'shStub' or 'scripts/' pre-creation: {'shStub' in vc}")
print(f"  'STEP 1' in queue prompt: {'STEP 1' in vc}")
print(f"  Old IMPACT-ASSESSMENT creation still present: {'IMPACT-ASSESSMENT.md' in vc}")
