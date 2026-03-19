import { execa } from 'execa';

export function buildSubmodulePointerCommitMessage(moduleNames: string[]): string {
  return `chore: update submodule pointers [${moduleNames.join(', ')}]`;
}

export async function updateSubmodulePointers(projectRoot: string): Promise<void> {
  await execa('git', ['submodule', 'update', '--recursive'], { cwd: projectRoot });
}

export async function stageSubmodulePointers(
  projectRoot: string,
  modulePaths: string[]
): Promise<void> {
  for (const path of modulePaths) {
    await execa('git', ['add', path], { cwd: projectRoot });
  }
}

export async function commitSubmodulePointers(
  projectRoot: string,
  moduleNames: string[],
  message?: string
): Promise<void> {
  const commitMsg = message ?? buildSubmodulePointerCommitMessage(moduleNames);
  await execa('git', ['commit', '-m', commitMsg], { cwd: projectRoot });
}

export async function gitInRoot(
  projectRoot: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execa('git', args, { cwd: projectRoot });
}
