// Use the agent-browser CLI to fetch the embed page and capture network requests
import { execSync } from 'child_process';

// The agent-browser CLI can navigate to a page and capture all network requests
// This will show us what API calls the obfuscated JS makes
const embedUrl = 'https://hanerix.com/e/idai5wak9cv0';

// Use agent-browser to navigate and snapshot
try {
  const result = execSync(
    `agent-browser navigate "${embedUrl}" --wait 5000`,
    { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
  );
  console.log('Navigate result:', result.slice(0, 2000));
} catch (e) {
  console.log('Navigate error:', e.message?.slice(0, 200));
}

// Try snapshot to see the rendered page
try {
  const result = execSync(
    `agent-browser snapshot`,
    { encoding: 'utf-8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 }
  );
  console.log('Snapshot:', result.slice(0, 3000));
} catch (e) {
  console.log('Snapshot error:', e.message?.slice(0, 200));
}
