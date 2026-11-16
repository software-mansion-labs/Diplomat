// What a machine that leaves the network takes out of docker: every container, relay,
// network and work volume this daemon made, found by the dn.base label each carries, so
// nothing of another daemon or another project is touched. The image stays: it holds
// nothing of any job, and building it again takes minutes.

import { BASE_DIR } from '../paths.js';
import { docker } from './container.js';

/// Removes them. Resolves to how many there were, or to null when the engine could not
/// say what there is.
export async function clearDocker() {
  const label = `label=dn.base=${BASE_DIR}`;
  const list = async (args) => {
    const listed = await docker(args);
    return listed.code === 0 ? listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : null;
  };
  const containers = await list(['ps', '-a', '--filter', label, '--format', '{{.Names}}']);
  if (containers === null) return null;
  await Promise.all(containers.map((name) => docker(['rm', '-f', name])));
  // A network goes once nothing is on it, a volume once nothing mounts it.
  const networks = (await list(['network', 'ls', '--filter', label, '--format', '{{.Name}}'])) ?? [];
  await Promise.all(networks.map((name) => docker(['network', 'rm', name])));
  const volumes = (await list(['volume', 'ls', '--filter', label, '--format', '{{.Name}}'])) ?? [];
  await Promise.all(volumes.map((name) => docker(['volume', 'rm', '-f', name])));
  return containers.length + networks.length + volumes.length;
}
