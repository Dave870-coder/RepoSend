import { sha256 } from '@noble/hashes/sha256';
import './style.css';

const GITHUB_API = 'https://api.github.com';
const GITLAB_API = 'https://gitlab.com/api/v4';
const DIRECT_UPLOAD_LIMIT = 70 * 1024 * 1024;
const MAX_TOTAL_SIZE = 250 * 1024 * 1024;
const GITLAB_MAX_TOTAL_SIZE = 100 * 1024 * 1024;
const MAX_FILE_COUNT = 5000;
const MAX_QUEUED_PUBLISHES = 5;
const MAX_REQUEST_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const LFS_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const HASH_CHUNK_SIZE = 1024 * 1024;

type SelectedFile = {
  file: File;
  path: string;
};

type ProviderId = 'github' | 'gitlab' | 'gitlab-self-managed';
type PublishInput = {
  provider: ProviderId;
  token: string;
  owner: string;
  repo: string;
  branch: string;
  lfsProxyUrl: string;
  gitLabApiBase: string;
  createRepository: boolean;
  openReview: boolean;
};
type QueuedPublish = {
  id: number;
  input: PublishInput;
  files: SelectedFile[];
  saveRecoveryCopy: boolean;
};
type CompletedPublish = {
  id: number;
  destination: string;
  links: Array<{ href: string; label: string }>;
};

type GitHubError = {
  message?: string;
  errors?: Array<{ message?: string }>;
};

type LfsObject = {
  oid: string;
  size: number;
  error?: { code: number; message: string };
  actions?: {
    upload?: { href: string; header?: Record<string, string> };
  };
};

type TreeEntry = {
  path: string;
  mode: '100644';
  type: 'blob';
  sha: string;
};

const form = document.querySelector<HTMLFormElement>('#publish-form')!;
const providerInput = document.querySelector<HTMLSelectElement>('#provider')!;
const gitLabInstanceInput = document.querySelector<HTMLInputElement>('#gitlab-instance')!;
const gitLabInstanceField = document.querySelector<HTMLDivElement>('#gitlab-instance-field')!;
const tokenInput = document.querySelector<HTMLInputElement>('#token')!;
const tokenLabel = document.querySelector<HTMLLabelElement>('#token-label')!;
const tokenHint = document.querySelector<HTMLSpanElement>('#token-hint')!;
const createTokenLink = document.querySelector<HTMLAnchorElement>('#create-token-link')!;
const repositoryInput = document.querySelector<HTMLInputElement>('#repository')!;
const verifyAccessButton = document.querySelector<HTMLButtonElement>('#verify-access')!;
const branchInput = document.querySelector<HTMLInputElement>('#branch')!;
const lfsProxyInput = document.querySelector<HTMLInputElement>('#lfs-proxy-url')!;
const lfsProxyField = document.querySelector<HTMLDivElement>('.proxy-field')!;
const filePicker = document.querySelector<HTMLInputElement>('#file-picker')!;
const folderPicker = document.querySelector<HTMLInputElement>('#folder-picker')!;
const selectedFilesElement = document.querySelector<HTMLDivElement>('#selected-files')!;
const fileCountElement = document.querySelector<HTMLSpanElement>('#file-count')!;
const dropArea = document.querySelector<HTMLDivElement>('#drop-area')!;
const statusElement = document.querySelector<HTMLDivElement>('#status')!;
const publishButton = document.querySelector<HTMLButtonElement>('#publish-button')!;
const publishButtonLabel = publishButton.querySelector<HTMLSpanElement>('span')!;
const queueCurrentButton = document.querySelector<HTMLButtonElement>('#queue-current')!;
const runQueueButton = document.querySelector<HTMLButtonElement>('#run-queue')!;
const queuedJobsElement = document.querySelector<HTMLOListElement>('#queued-jobs')!;
const providerHeading = document.querySelector<HTMLHeadingElement>('#provider-heading')!;
const providerBadge = document.querySelector<HTMLSpanElement>('.github-badge')!;
const providerBadgeName = document.querySelector<HTMLSpanElement>('#provider-badge-name')!;
const githubBadgeIcon = document.querySelector<SVGElement>('#github-badge-icon')!;
const publishWorkspace = document.querySelector<HTMLElement>('#publish-workspace')!;
const fileLimitHint = document.querySelector<HTMLParagraphElement>('#file-limit-hint')!;
const privacyCopy = document.querySelector<HTMLParagraphElement>('#privacy-copy')!;
const createRepositoryInput = document.querySelector<HTMLInputElement>('#create-repository')!;
const openReviewInput = document.querySelector<HTMLInputElement>('#open-review')!;
const saveRecoveryCopyInput = document.querySelector<HTMLInputElement>('#save-recovery-copy')!;
const RECOVERY_DB_NAME = 'reposend-recovery';
const RECOVERY_STORE_NAME = 'selections';
const RECOVERY_KEY = 'pending-publish';

type RecoveryRecord = {
  id: string;
  context: string;
  files: Array<{
    path: string;
    name: string;
    type: string;
    lastModified: number;
    content: Blob;
    blobSha?: string;
  }>;
};

let selectedFiles: SelectedFile[] = [];
let recoveryRestored = false;
let queuedPublishes: QueuedPublish[] = [];
let completedPublishes: CompletedPublish[] = [];
let nextQueuedPublishId = 1;
let queueRunning = false;
let queueAdding = false;
let publishBusy = false;

providerInput.addEventListener('change', () => {
  tokenInput.value = '';
  updateProviderUi();
  setStatus('', '');
});
gitLabInstanceInput.addEventListener('input', updateProviderUi);
updateProviderUi();
if (!window.indexedDB) {
  saveRecoveryCopyInput.disabled = true;
  saveRecoveryCopyInput.parentElement!.title = 'IndexedDB is unavailable in this browser.';
} else {
  void restoreRecoveryCopy().catch((error: unknown) => {
    setStatus(error instanceof Error ? `Could not restore the local recovery copy: ${error.message}` : 'Could not restore the local recovery copy.', 'error');
  });
}
saveRecoveryCopyInput.addEventListener('change', () => {
  if (!saveRecoveryCopyInput.checked && window.indexedDB) {
    recoveryRestored = false;
    void clearRecoveryCopy().catch((error: unknown) => {
      setStatus(error instanceof Error ? `Could not clear the local recovery copy: ${error.message}` : 'Could not clear the local recovery copy.', 'error');
    });
  }
});

document.querySelector<HTMLButtonElement>('#choose-files')!.addEventListener('click', () => filePicker.click());
document.querySelector<HTMLButtonElement>('#choose-folder')!.addEventListener('click', () => folderPicker.click());

filePicker.addEventListener('change', () => {
  if (filePicker.files) addFiles(Array.from(filePicker.files));
  filePicker.value = '';
});

folderPicker.addEventListener('change', () => {
  if (folderPicker.files) addFiles(Array.from(folderPicker.files));
  folderPicker.value = '';
});

document.querySelector<HTMLButtonElement>('#toggle-token')!.addEventListener('click', (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const isVisible = tokenInput.type === 'text';
  tokenInput.type = isVisible ? 'password' : 'text';
  button.textContent = isVisible ? 'Show' : 'Hide';
  button.setAttribute('aria-label', isVisible ? 'Show token' : 'Hide token');
  button.setAttribute('aria-pressed', String(!isVisible));
});

repositoryInput.addEventListener('blur', () => {
  const repository = parseRepositoryInput(repositoryInput.value);
  if (repository) repositoryInput.value = `${repository.owner}/${repository.repo}`;
});

verifyAccessButton.addEventListener('click', () => {
  void verifyTokenAccess();
});

window.addEventListener('pagehide', () => {
  tokenInput.value = '';
  queuedPublishes = [];
});

function getSelectedProvider(): ProviderId {
  return providerInput.value === 'gitlab' || providerInput.value === 'gitlab-self-managed'
    ? providerInput.value
    : 'github';
}

function providerName(provider = getSelectedProvider()): string {
  if (provider === 'gitlab-self-managed') return 'GitLab';
  return provider === 'gitlab' ? 'GitLab.com' : 'GitHub';
}

function isGitLabProvider(provider = getSelectedProvider()): boolean {
  return provider !== 'github';
}

function getGitLabApiBase(provider = getSelectedProvider()): string {
  if (provider === 'gitlab') return GITLAB_API;
  if (provider !== 'gitlab-self-managed') return GITLAB_API;
  const instance = parseGitLabInstanceUrl(gitLabInstanceInput.value);
  if (!instance) throw new Error('Enter a valid HTTPS URL for your GitLab instance.');
  return `${instance}/api/v4`;
}

function parseGitLabInstanceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !localHttp)
      || url.username
      || url.password
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search
      || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function updateProviderUi(): void {
  const provider = getSelectedProvider();
  const github = provider === 'github';
  const selfManagedGitLab = provider === 'gitlab-self-managed';

  tokenLabel.textContent = github ? 'GitHub personal access token' : 'GitLab personal access token';
  tokenInput.placeholder = github ? 'ghp_… or github_pat_…' : 'glpat-…';
  tokenHint.textContent = github
    ? 'Fine-grained: include this repository, with Contents read/write and Metadata read-only. Classic: repo scope.'
    : 'Create a personal access token with the api scope. The token stays in browser memory only.';
  createTokenLink.href = github
    ? 'https://github.com/settings/personal-access-tokens/new'
    : selfManagedGitLab
      ? `${parseGitLabInstanceUrl(gitLabInstanceInput.value) ?? 'https://gitlab.com'}/-/user_settings/personal_access_tokens`
      : 'https://gitlab.com/-/user_settings/personal_access_tokens';
  repositoryInput.placeholder = github
    ? 'owner/repository or GitHub URL'
    : selfManagedGitLab
      ? 'namespace/project or GitLab URL'
      : 'namespace/project or GitLab.com URL';
  providerHeading.textContent = `Send to ${providerName(provider)}`;
  providerBadgeName.textContent = providerName(provider);
  providerBadge.setAttribute('aria-label', providerName(provider));
  githubBadgeIcon.toggleAttribute('hidden', !github);
  publishWorkspace.setAttribute('aria-label', `Publish to ${providerName(provider)}`);
  publishButtonLabel.textContent = `Publish to ${providerName(provider)}`;
  gitLabInstanceField.hidden = !selfManagedGitLab;
  lfsProxyField.hidden = !github;
  fileLimitHint.textContent = github
    ? 'Up to 250 MiB total per send. Files over 70 MiB use your Worker (90 MiB default per file); use the CLI with Git LFS for larger files.'
    : 'Any file type, up to 100 MiB per send. Larger GitLab files require the CLI and your Git LFS setup.';

  const privacyEmphasis = privacyCopy.querySelector('strong')!;
  privacyCopy.replaceChildren(
    privacyEmphasis,
    document.createTextNode(github
      ? ' Regular files go directly to GitHub. Git LFS files and the token pass through your configured Worker; the supplied Worker does not intentionally store or log them.'
      : selfManagedGitLab
        ? ' Your GitLab token and selected files go directly to the configured GitLab instance. RepoSend does not run an upload server for this browser flow.'
        : ' Your GitLab token and selected files go directly to GitLab.com. RepoSend does not run an upload server for this browser flow.'),
  );
}

dropArea.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropArea.classList.add('is-dragging');
});

dropArea.addEventListener('dragleave', (event) => {
  if (!dropArea.contains(event.relatedTarget as Node | null)) {
    dropArea.classList.remove('is-dragging');
  }
});

dropArea.addEventListener('drop', (event) => {
  event.preventDefault();
  dropArea.classList.remove('is-dragging');
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) addFiles(files);
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void publish();
});
queueCurrentButton.addEventListener('click', () => {
  void queueCurrentPublish();
});
runQueueButton.addEventListener('click', () => {
  void runQueuedPublishes();
});

function addFiles(files: File[]): void {
  if (publishButton.disabled) return;
  const additions: SelectedFile[] = files.map((file) => ({
    file,
    path: normalizePath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name),
  }));
  selectedFiles = [...selectedFiles, ...additions];
  recoveryRestored = false;
  if (window.indexedDB) {
    void clearRecoveryCopy().catch((error: unknown) => {
      setStatus(error instanceof Error ? `Could not clear the outdated recovery copy: ${error.message}` : 'Could not clear the outdated recovery copy.', 'error');
    });
  }
  renderFiles();
  setStatus('', '');
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/, '');
}

function isValidBranchName(branch: string): boolean {
  const invalidCharacter = Array.from(branch).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || '~^:?*[]\\'.includes(character);
  });
  return Boolean(branch)
    && !branch.startsWith('/')
    && !branch.endsWith('/')
    && !branch.includes('..')
    && !branch.includes('@{')
    && !invalidCharacter
    && !branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'));
}

function renderFiles(): void {
  const totalSize = selectedFiles.reduce((sum, item) => sum + item.file.size, 0);
  fileCountElement.textContent = selectedFiles.length
    ? `${selectedFiles.length.toLocaleString()} file${selectedFiles.length === 1 ? '' : 's'} · ${formatBytes(totalSize)}`
    : 'Nothing selected yet';
  selectedFilesElement.replaceChildren();

  if (!selectedFiles.length) return;

  const summary = document.createElement('div');
  summary.className = 'files-summary';
  summary.textContent = `${selectedFiles.length.toLocaleString()} selected`;
  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'text-button clear-files';
  clearButton.textContent = 'Clear all';
  clearButton.disabled = publishBusy || queueRunning;
  clearButton.addEventListener('click', () => {
    selectedFiles = [];
    recoveryRestored = false;
    renderFiles();
    setStatus('', '');
    if (window.indexedDB) {
      void clearRecoveryCopy().catch((error: unknown) => {
        setStatus(error instanceof Error ? `Could not clear the local recovery copy: ${error.message}` : 'Could not clear the local recovery copy.', 'error');
      });
    }
  });
  summary.append(clearButton);
  selectedFilesElement.append(summary);

  const list = document.createElement('ul');
  list.className = 'file-list';
  for (const item of selectedFiles.slice(0, 5)) {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = item.path;
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = formatBytes(item.file.size);
    row.append(name, size);
    list.append(row);
  }
  selectedFilesElement.append(list);

  if (selectedFiles.length > 5) {
    const remaining = document.createElement('p');
    remaining.className = 'remaining-files';
    remaining.textContent = `and ${selectedFiles.length - 5} more`;
    selectedFilesElement.append(remaining);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function setStatus(message: string, type: 'error' | 'success' | 'info' | ''): void {
  statusElement.textContent = message;
  statusElement.className = `status-message${type ? ` ${type}` : ''}`;
}

function parseRepositoryInput(value: string): { owner: string; repo: string } | null {
  if (isGitLabProvider()) return parseGitLabRepositoryInput(value);
  return parseGitHubRepositoryInput(value);
}

function parseGitHubRepositoryInput(value: string): { owner: string; repo: string } | null {
  let repository = value.trim();
  if (!repository) return null;

  if (/^git@github\.com:/i.test(repository)) {
    repository = repository.slice('git@github.com:'.length);
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(repository)) {
    try {
      const url = new URL(repository);
      if (
        url.protocol !== 'https:'
        || url.hostname.toLowerCase() !== 'github.com'
        || url.username
        || url.password
        || url.search
        || url.hash
      ) {
        return null;
      }
      repository = url.pathname;
    } catch {
      return null;
    }
  }

  repository = repository.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const parts = repository.split('/');
  if (parts.length !== 2) return null;

  const [owner, repo] = parts.map((part) => part.trim());
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

function parseGitLabRepositoryInput(value: string): { owner: string; repo: string } | null {
  let repository = value.trim();
  if (!repository) return null;

  const provider = getSelectedProvider();
  const expectedOrigin = provider === 'gitlab-self-managed'
    ? parseGitLabInstanceUrl(gitLabInstanceInput.value)
    : 'https://gitlab.com';
  if (!expectedOrigin) return null;

  if (/^git@[^:]+:/i.test(repository)) {
    const match = /^git@([^:]+):(.+)$/.exec(repository);
    if (!match || `https://${match[1].toLowerCase()}` !== expectedOrigin) return null;
    repository = match[2];
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(repository)) {
    try {
      const url = new URL(repository);
      if (
        url.origin !== expectedOrigin
        || url.username
        || url.password
        || url.search
        || url.hash
      ) {
        return null;
      }
      repository = url.pathname;
    } catch {
      return null;
    }
  }

  repository = repository.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  let parts: string[];
  try {
    parts = repository.split('/').map((part) => decodeURIComponent(part).trim());
  } catch {
    return null;
  }
  if (
    parts.length < 2
    || parts.some((part) => !part || part === '.' || part === '..' || /[\/\\\s?#]/.test(part))
  ) {
    return null;
  }

  return { owner: parts.slice(0, -1).join('/'), repo: parts[parts.length - 1] };
}

async function verifyTokenAccess(): Promise<void> {
  const token = tokenInput.value.trim();
  const repository = parseRepositoryInput(repositoryInput.value);
  const provider = getSelectedProvider();

  if (provider === 'gitlab-self-managed' && !parseGitLabInstanceUrl(gitLabInstanceInput.value)) {
    setStatus('Enter a valid HTTPS URL for your GitLab instance.', 'error');
    gitLabInstanceInput.focus();
    return;
  }
  if (!token) {
    setStatus(`Add a ${providerName(provider)} access token to continue.`, 'error');
    tokenInput.focus();
    return;
  }
  if (!repository) {
    setStatus(
      provider === 'github'
        ? 'Enter owner/repository or paste a GitHub repository URL.'
        : provider === 'gitlab-self-managed'
          ? 'Enter namespace/project or paste a URL from your configured GitLab instance.'
          : 'Enter namespace/project or paste a GitLab.com repository URL.',
      'error',
    );
    repositoryInput.focus();
    return;
  }

  providerInput.disabled = true;
  tokenInput.disabled = true;
  repositoryInput.disabled = true;
  verifyAccessButton.disabled = true;
  publishButton.disabled = true;
  setStatus(`Verifying the token and repository access with ${providerName(provider)}…`, 'info');

  try {
    let accountName: string;
    let repositoryWillBeCreated = false;
    if (provider === 'github') {
      const user = await githubRequest<{ login?: string }>('/user', token);
      if (!user.login) throw new Error('GitHub did not return the account for this token.');
      try {
        await githubRequest(
          `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
          token,
        );
      } catch (error) {
        if (
          !createRepositoryInput.checked
          || !(error instanceof Error)
          || error.message !== 'Repository or branch not found, or the token does not have access.'
        ) throw error;
        repositoryWillBeCreated = true;
      }
      accountName = user.login;
    } else {
      const user = await gitLabRequest<unknown>('/user', token);
      const username = isRecord(user.data) ? user.data.username : undefined;
      if (typeof username !== 'string' || !username) {
        throw new Error('GitLab did not return the account for this token.');
      }
      try {
        await gitLabRequest(
          `/projects/${encodeURIComponent(`${repository.owner}/${repository.repo}`)}`,
          token,
        );
      } catch (error) {
        if (!createRepositoryInput.checked || !(error instanceof GitLabApiError) || error.status !== 404) {
          throw error;
        }
        repositoryWillBeCreated = true;
      }
      accountName = username;
    }
    repositoryInput.value = `${repository.owner}/${repository.repo}`;
    setStatus(
      repositoryWillBeCreated
        ? `Token verified for @${accountName}; ${repository.owner}/${repository.repo} will be created as a private repository when you publish.`
        : `Token verified for @${accountName}; ${repository.owner}/${repository.repo} is accessible. Publishing will confirm write permission.`,
      'success',
    );
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : 'Could not verify this token. Please try again.',
      'error',
    );
  } finally {
    providerInput.disabled = false;
    tokenInput.disabled = false;
    repositoryInput.disabled = false;
    verifyAccessButton.disabled = false;
    publishButton.disabled = false;
  }
}

function validateInput(): PublishInput | null {
  const provider = getSelectedProvider();
  const token = tokenInput.value.trim();
  let gitLabApiBase = '';
  if (provider === 'gitlab-self-managed') {
    try {
      gitLabApiBase = getGitLabApiBase(provider);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Enter a valid GitLab instance URL.', 'error');
      gitLabInstanceInput.focus();
      return null;
    }
  } else if (provider === 'gitlab') {
    gitLabApiBase = GITLAB_API;
  }
  const repository = parseRepositoryInput(repositoryInput.value);
  const branch = branchInput.value.trim();
  const lfsFiles = provider === 'github'
    ? selectedFiles.filter((item) => item.file.size > DIRECT_UPLOAD_LIMIT)
    : [];

  if (!token) {
    setStatus(`Add a ${providerName(provider)} access token to continue.`, 'error');
    tokenInput.focus();
    return null;
  }
  if (!repository) {
    setStatus(
      provider === 'github'
        ? 'Enter owner/repository or paste a GitHub repository URL.'
        : provider === 'gitlab-self-managed'
          ? 'Enter namespace/project or paste a URL from your configured GitLab instance.'
          : 'Enter namespace/project or paste a GitLab.com repository URL.',
      'error',
    );
    repositoryInput.focus();
    return null;
  }
  if (!isValidBranchName(branch)) {
    setStatus('Enter a valid branch name.', 'error');
    branchInput.focus();
    return null;
  }
  if (!selectedFiles.length) {
    setStatus('Choose at least one file to publish.', 'error');
    document.querySelector<HTMLButtonElement>('#choose-files')!.focus();
    return null;
  }
  if (selectedFiles.length > MAX_FILE_COUNT) {
    setStatus(`Choose no more than ${MAX_FILE_COUNT.toLocaleString()} files at a time.`, 'error');
    return null;
  }

  let lfsProxyUrl = '';
  if (lfsFiles.length) {
    try {
      const proxyUrl = new URL(lfsProxyInput.value.trim());
      const localHttp = proxyUrl.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(proxyUrl.hostname);
      if (
        (proxyUrl.protocol !== 'https:' && !localHttp)
        || proxyUrl.username
        || proxyUrl.password
        || (proxyUrl.pathname !== '/' && proxyUrl.pathname !== '')
        || proxyUrl.search
        || proxyUrl.hash
      ) {
        throw new Error('Invalid URL');
      }
      lfsProxyUrl = proxyUrl.origin;
    } catch {
      setStatus('Add your HTTPS RepoSend LFS Worker URL for files over 70 MiB, or use the CLI with Git LFS for larger files.', 'error');
      lfsProxyInput.focus();
      return null;
    }
  }

  const paths = new Set<string>();
  let totalSize = 0;
  for (const item of selectedFiles) {
    if (!item.path || item.path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      setStatus(`Invalid file path: ${item.path || item.file.name}`, 'error');
      return null;
    }
    if (/[\r\n]/.test(item.path)) {
      setStatus('File paths containing line breaks cannot be safely added to Git attributes.', 'error');
      return null;
    }
    if (item.path.split('/').includes('.git')) {
      setStatus('Git metadata cannot be published. Remove the .git folder and try again.', 'error');
      return null;
    }
    if (paths.has(item.path)) {
      setStatus(`More than one selected file has the path "${item.path}". Clear the selection and try again.`, 'error');
      return null;
    }
    paths.add(item.path);
    totalSize += item.file.size;
  }
  if (lfsFiles.length && selectedFiles.some((item) => item.path === '.gitattributes' && item.file.size > 1024 * 1024)) {
    setStatus('The root .gitattributes file must be no larger than 1 MiB when adding Git LFS rules.', 'error');
    return null;
  }
  const totalSizeLimit = isGitLabProvider(provider) ? GITLAB_MAX_TOTAL_SIZE : MAX_TOTAL_SIZE;
  if (totalSize > totalSizeLimit) {
    setStatus(
      `The selected files exceed the ${formatBytes(totalSizeLimit)} ${providerName(provider)} browser publish limit.`,
      'error',
    );
    return null;
  }

  return {
    provider,
    token,
    owner: repository.owner,
    repo: repository.repo,
    branch,
    lfsProxyUrl,
    gitLabApiBase,
    createRepository: createRepositoryInput.checked,
    openReview: openReviewInput.checked,
  };
}

class GitLabApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitLabApiError';
    this.status = status;
  }
}

async function gitLabRequest<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<{ data: T; response: Response }> {
  const response = await fetchWithRetry(`${getGitLabApiBase()}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'PRIVATE-TOKEN': token,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  }, REQUEST_TIMEOUT_MS, 'GitLab');

  if (!response.ok) {
    let detail = '';
    try {
      const body: unknown = await response.json();
      if (isRecord(body)) {
        if (typeof body.message === 'string') detail = body.message;
        else if (Array.isArray(body.message)) detail = body.message.join(' ');
        else if (typeof body.error === 'string') detail = body.error;
      }
    } catch {
      detail = response.statusText;
    }

    if (response.status === 401) {
      throw new GitLabApiError('GitLab rejected the token. Check it and try again.', response.status);
    }
    if (response.status === 403) {
      throw new GitLabApiError(detail || 'GitLab denied access. Check the token scope and project permissions.', response.status);
    }
    if (response.status === 404) {
      throw new GitLabApiError('GitLab project or branch not found, or the token does not have access.', response.status);
    }
    if (response.status === 413) {
      throw new GitLabApiError(detail || 'GitLab rejected the request size. Try fewer or smaller files, or use the CLI with Git LFS.', response.status);
    }
    if ([400, 409, 422].includes(response.status)) {
      throw new GitLabApiError(detail || 'GitLab could not accept this update. The branch may have changed; try again.', response.status);
    }
    throw new GitLabApiError(detail || `GitLab returned an error (${response.status}).`, response.status);
  }

  if (response.status === 204) return { data: undefined as T, response };
  try {
    return { data: await response.json() as T, response };
  } catch {
    throw new Error('GitLab returned an invalid response. Please try again.');
  }
}

async function githubRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithRetry(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  }, REQUEST_TIMEOUT_MS, 'GitHub');

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json() as GitHubError;
      detail = body.errors?.map((error) => error.message).filter(Boolean).join(' ') || body.message || '';
    } catch {
      detail = response.statusText;
    }

    if (response.status === 401) throw new Error('GitHub rejected the token. Check it and try again.');
    if (response.status === 403) throw new Error(detail || 'GitHub denied access. Check the token permissions and your API rate limit.');
    if (response.status === 404) throw new Error('Repository or branch not found, or the token does not have access.');
    if (response.status === 413) throw new Error('GitHub rejected the upload size. Regular Git files cannot exceed 100 MiB; use Git LFS or a Git client for larger files.');
    if (response.status === 422) throw new Error(detail || 'GitHub could not accept this update. The branch may have changed; try again.');
    throw new Error(detail || `GitHub returned an error (${response.status}).`);
  }

  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function ensureGitHubRepository(owner: string, repo: string, token: string): Promise<unknown> {
  try {
    return await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Repository or branch not found, or the token does not have access.') {
      throw error;
    }
  }

  const account = await githubRequest<{ login?: string }>('/user', token);
  if (!account.login) throw new Error('GitHub did not return the authenticated account name.');
  const endpoint = account.login.toLowerCase() === owner.toLowerCase()
    ? '/user/repos'
    : `/orgs/${encodeURIComponent(owner)}/repos`;
  return await githubRequest(endpoint, token, {
    method: 'POST',
    body: JSON.stringify({ name: repo, private: true, auto_init: true }),
  });
}

async function ensureGitLabProject(owner: string, repo: string, token: string): Promise<unknown> {
  try {
    const response = await gitLabRequest<unknown>(
      `/projects/${encodeURIComponent(`${owner}/${repo}`)}`,
      token,
    );
    return response.data;
  } catch (error) {
    if (!(error instanceof GitLabApiError) || error.status !== 404) throw error;
  }

  const namespaces = await gitLabRequest<unknown[]>(
    `/namespaces?search=${encodeURIComponent(owner)}&per_page=100`,
    token,
  );
  const namespace = namespaces.data.find((item) =>
    isRecord(item) && item.full_path === owner && Number.isSafeInteger(item.id),
  );
  if (!isRecord(namespace) || typeof namespace.id !== 'number') {
    throw new Error(`Could not find the GitLab namespace "${owner}" or the token cannot create projects there.`);
  }
  const created = await gitLabRequest<unknown>('/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: repo,
      path: repo,
      namespace_id: namespace.id,
      visibility: 'private',
      initialize_with_readme: true,
    }),
  });
  return created.data;
}

async function createGitHubPullRequest(
  owner: string,
  repo: string,
  sourceBranch: string,
  targetBranch: string,
  token: string,
): Promise<string> {
  const query = new URLSearchParams({ state: 'open', head: `${owner}:${sourceBranch}`, base: targetBranch });
  const existing = await githubRequest<unknown[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query}`,
    token,
  );
  const found = existing.find((item) => isRecord(item) && typeof item.html_url === 'string');
  if (isRecord(found) && typeof found.html_url === 'string') {
    return validateWebUrl(found.html_url, 'https://github.com', 'GitHub');
  }

  const created = await githubRequest<unknown>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        title: `Publish ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} with RepoSend`,
        head: sourceBranch,
        base: targetBranch,
      }),
    },
  );
  if (!isRecord(created) || typeof created.html_url !== 'string') {
    throw new Error('GitHub returned an invalid pull request response.');
  }
  return validateWebUrl(created.html_url, 'https://github.com', 'GitHub');
}

async function createGitLabMergeRequest(
  repositoryPath: string,
  sourceBranch: string,
  targetBranch: string,
  token: string,
): Promise<string> {
  const query = new URLSearchParams({
    state: 'opened',
    source_branch: sourceBranch,
    target_branch: targetBranch,
  });
  const existing = await gitLabRequest<unknown[]>(`${repositoryPath}/merge_requests?${query}`, token);
  const found = existing.data.find((item) => isRecord(item) && typeof item.web_url === 'string');
  if (isRecord(found) && typeof found.web_url === 'string') {
    return validateWebUrl(found.web_url, new URL(getGitLabApiBase()).origin, 'GitLab');
  }

  const created = await gitLabRequest<unknown>(`${repositoryPath}/merge_requests`, token, {
    method: 'POST',
    body: JSON.stringify({
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title: `Publish ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} with RepoSend`,
    }),
  });
  if (!isRecord(created.data) || typeof created.data.web_url !== 'string') {
    throw new Error('GitLab returned an invalid merge request response.');
  }
  return validateWebUrl(created.data.web_url, new URL(getGitLabApiBase()).origin, 'GitLab');
}

function validateWebUrl(value: string, expectedOrigin: string, provider: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${provider} returned an invalid review URL.`);
  }
  if (url.origin !== expectedOrigin || url.username || url.password) {
    throw new Error(`${provider} returned an unexpected review URL.`);
  }
  return url.href;
}

function appendResultLink(href: string, label: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = label;
  link.className = 'commit-link';
  statusElement.append(' ', link);
}

async function lfsProxyRequest<T>(
  proxyUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchWithRetry(`${proxyUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  }, LFS_REQUEST_TIMEOUT_MS, 'Git LFS Worker');

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json() as GitHubError;
      detail = body.message || '';
    } catch {
      detail = response.statusText;
    }
    if (response.status === 401 || response.status === 403) throw new Error(detail || 'The Git LFS Worker rejected this request.');
    if (response.status === 413) throw new Error(detail || 'The Git LFS Worker upload limit was exceeded.');
    throw new Error(detail || `Git LFS Worker returned an error (${response.status}).`);
  }

  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  serviceName: string,
): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch {
      if (attempt === MAX_REQUEST_ATTEMPTS - 1) {
        throw new Error(`Could not reach ${serviceName} after several attempts. Check your connection and try again.`);
      }
      setStatus(`Connection interrupted. Retrying request ${attempt + 2} of ${MAX_REQUEST_ATTEMPTS}…`, 'info');
      await delay(500 * 2 ** attempt);
      continue;
    } finally {
      window.clearTimeout(timeout);
    }

    if (response.ok || !isRetryable(response) || attempt === MAX_REQUEST_ATTEMPTS - 1) break;
    const retryDelay = getRetryDelay(response, attempt);
    if (retryDelay === null) break;
    setStatus(
      `${serviceName} is temporarily unavailable (HTTP ${response.status}). Retrying request ${attempt + 2} of ${MAX_REQUEST_ATTEMPTS}…`,
      'info',
    );
    await delay(retryDelay);
  }

  if (!response) {
    throw new Error(`Could not reach ${serviceName}. Check your connection and try again.`);
  }
  return response;
}

function isRetryable(response: Response): boolean {
  if ([408, 429, 500, 502, 503, 504].includes(response.status)) return true;
  return response.status === 403
    && (response.headers.has('Retry-After') || response.headers.get('X-RateLimit-Remaining') === '0');
}

function getRetryDelay(response: Response, attempt: number): number | null {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requestedDelay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    return requestedDelay > 60_000 ? null : Math.max(100, requestedDelay);
  }

  if (response.headers.get('X-RateLimit-Remaining') === '0') return null;
  return 500 * 2 ** attempt;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function toBase64Chunks(file: File, onProgress: (processedBytes: number) => void): Promise<string[]> {
  const encodedChunks: string[] = [];
  const chunkSize = 48 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    encodedChunks.push(btoa(binary));
    if (encodedChunks.length % 32 === 0 || offset + chunkSize >= file.size) {
      onProgress(Math.min(file.size, offset + chunkSize));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  return encodedChunks;
}

function createBlobRequestBody(encodedChunks: string[]): Blob {
  return new Blob(
    ['{"content":"', ...encodedChunks, '","encoding":"base64"}'],
    { type: 'application/json' },
  );
}

function openRecoveryDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('This browser does not support IndexedDB recovery copies.'));
      return;
    }
    const request = window.indexedDB.open(RECOVERY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RECOVERY_STORE_NAME)) {
        request.result.createObjectStore(RECOVERY_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened.'));
    request.onblocked = () => reject(new Error('Another tab is blocking the recovery database upgrade.'));
  });
}

function recoveryContext(input: PublishInput): string {
  return `${input.provider}:${input.owner}/${input.repo}:${input.branch}`;
}

async function saveRecoveryCopy(input: PublishInput): Promise<void> {
  const database = await openRecoveryDatabase();
  try {
    const previous = await new Promise<RecoveryRecord | undefined>((resolve, reject) => {
      const transaction = database.transaction(RECOVERY_STORE_NAME, 'readonly');
      const request = transaction.objectStore(RECOVERY_STORE_NAME).get(RECOVERY_KEY);
      request.onsuccess = () => resolve(request.result as RecoveryRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error('The browser could not read the previous checkpoint.'));
    });
    const previousFiles = previous && Array.isArray(previous.files) ? previous.files : [];
    const canReuse = recoveryRestored
      && previous?.context === recoveryContext(input)
      && previousFiles.length === selectedFiles.length
      && previousFiles.every((item, index) => {
        const selected = selectedFiles[index];
        return item.path === selected.path
          && item.name === selected.file.name
          && item.type === selected.file.type
          && item.lastModified === selected.file.lastModified
          && item.content.size === selected.file.size;
      });
    const previousByPath = new Map(previousFiles.map((item) => [item.path, item.blobSha]));
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(RECOVERY_STORE_NAME, 'readwrite');
      transaction.objectStore(RECOVERY_STORE_NAME).put({
        id: RECOVERY_KEY,
        context: recoveryContext(input),
        files: selectedFiles.map(({ file, path }) => ({
          path,
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
          content: file,
          ...(canReuse && previousByPath.get(path) ? { blobSha: previousByPath.get(path) } : {}),
        })),
      } satisfies RecoveryRecord);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('The browser could not save the selected files.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('The browser aborted saving the selected files.'));
    });
    recoveryRestored = true;
  } finally {
    database.close();
  }
}

async function restoreRecoveryCopy(): Promise<void> {
  const database = await openRecoveryDatabase();
  let record: RecoveryRecord | undefined;
  try {
    record = await new Promise<RecoveryRecord | undefined>((resolve, reject) => {
      const transaction = database.transaction(RECOVERY_STORE_NAME, 'readonly');
      const request = transaction.objectStore(RECOVERY_STORE_NAME).get(RECOVERY_KEY);
      request.onsuccess = () => resolve(request.result as RecoveryRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error('The browser could not read the recovery copy.'));
    });
  } finally {
    database.close();
  }
  if (!record || !Array.isArray(record.files) || selectedFiles.length) return;
  if (record.files.some((item) =>
    !item
    || typeof item.path !== 'string'
    || typeof item.name !== 'string'
    || typeof item.type !== 'string'
    || typeof item.lastModified !== 'number'
    || !(item.content instanceof Blob)
    || (item.blobSha !== undefined && (typeof item.blobSha !== 'string' || !/^[a-f\d]{40}$/i.test(item.blobSha)))
  )) {
    throw new Error('The saved selection is invalid. Clear browser storage and choose the files again.');
  }
  selectedFiles = record.files.map((item) => ({
    path: item.path,
    file: new File([item.content], item.name, { type: item.type, lastModified: item.lastModified }),
  }));
  recoveryRestored = true;
  saveRecoveryCopyInput.checked = true;
  renderFiles();
  setStatus('Restored the saved file selection. Re-enter your token and destination, then publish to retry.', 'info');
}

async function clearRecoveryCopy(): Promise<void> {
  const database = await openRecoveryDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(RECOVERY_STORE_NAME, 'readwrite');
      transaction.objectStore(RECOVERY_STORE_NAME).delete(RECOVERY_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('The browser could not remove the recovery copy.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('The browser aborted removing the recovery copy.'));
    });
  } finally {
    database.close();
  }
}

async function removeRecoveryCopy(): Promise<string> {
  if (!window.indexedDB) return '';
  try {
    await clearRecoveryCopy();
    return '';
  } catch (error) {
    return `Published successfully, but the local recovery copy could not be removed: ${error instanceof Error ? error.message : 'unknown storage error'}`;
  }
}

async function getBlobCheckpoint(item: SelectedFile, input: PublishInput): Promise<string | undefined> {
  if (!saveRecoveryCopyInput.checked) return undefined;
  const database = await openRecoveryDatabase();
  try {
    const record = await new Promise<RecoveryRecord | undefined>((resolve, reject) => {
      const transaction = database.transaction(RECOVERY_STORE_NAME, 'readonly');
      const request = transaction.objectStore(RECOVERY_STORE_NAME).get(RECOVERY_KEY);
      request.onsuccess = () => resolve(request.result as RecoveryRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error('The browser could not read the file checkpoint.'));
    });
    const checkpoint = record?.files.find((file) =>
      file.path === item.path
      && file.name === item.file.name
      && file.type === item.file.type
      && file.lastModified === item.file.lastModified
      && file.content.size === item.file.size
    );
    if (checkpoint?.blobSha && !/^[a-f\d]{40}$/i.test(checkpoint.blobSha)) {
      throw new Error(`The saved checkpoint for "${item.path}" is invalid.`);
    }
    return record?.context === recoveryContext(input) ? checkpoint?.blobSha : undefined;
  } finally {
    database.close();
  }
}

async function saveBlobCheckpoint(item: SelectedFile, input: PublishInput, sha: string): Promise<void> {
  if (!saveRecoveryCopyInput.checked) return;
  const database = await openRecoveryDatabase();
  try {
    const record = await new Promise<RecoveryRecord | undefined>((resolve, reject) => {
      const transaction = database.transaction(RECOVERY_STORE_NAME, 'readonly');
      const request = transaction.objectStore(RECOVERY_STORE_NAME).get(RECOVERY_KEY);
      request.onsuccess = () => resolve(request.result as RecoveryRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error('The browser could not read the file checkpoint.'));
    });
    if (!record || record.context !== recoveryContext(input)) {
      throw new Error('The recovery checkpoint no longer matches this publish.');
    }
    const checkpoint = record.files.find((file) =>
      file.path === item.path
      && file.name === item.file.name
      && file.type === item.file.type
      && file.lastModified === item.file.lastModified
      && file.content.size === item.file.size
    );
    if (!checkpoint) throw new Error(`Could not find a recovery checkpoint for "${item.path}".`);
    checkpoint.blobSha = sha;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(RECOVERY_STORE_NAME, 'readwrite');
      transaction.objectStore(RECOVERY_STORE_NAME).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('The browser could not save the completed file checkpoint.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('The browser aborted saving the completed file checkpoint.'));
    });
  } finally {
    database.close();
  }
}

async function publish(inputOverride?: PublishInput, filesOverride?: SelectedFile[]): Promise<boolean> {
  const input = inputOverride ?? validateInput();
  if (!input) return false;
  if (filesOverride) selectedFiles = filesOverride;

  setBusy(true);
  setStatus('Checking the repository and preparing your commit…', 'info');

  try {
    if (saveRecoveryCopyInput.checked) {
      setStatus('Saving a local recovery copy before publishing…', 'info');
      await saveRecoveryCopy(input);
    }
    if (isGitLabProvider(input.provider)) {
      await publishToGitLab(input);
      return true;
    }

    const { owner, repo, branch, token, lfsProxyUrl } = input;
    const lfsFiles = selectedFiles.filter((item) => item.file.size > DIRECT_UPLOAD_LIMIT);
    const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const encodedBranch = encodeURIComponent(branch);
    let repository: { default_branch?: string | null; has_pages?: boolean };
    try {
      repository = await githubRequest(repositoryPath, token);
    } catch (error) {
      if (
        !input.createRepository
        || !(error instanceof Error)
        || error.message !== 'Repository or branch not found, or the token does not have access.'
      ) throw error;
      const created = await ensureGitHubRepository(owner, repo, token);
      if (!isRecord(created)) throw new Error('GitHub returned an invalid repository response.');
      repository = created;
    }

    const reviewTargetBranch = repository.default_branch || '';
    if (input.openReview && !reviewTargetBranch) {
      throw new Error('GitHub did not report a default branch, so a pull request cannot be created.');
    }
    if (input.openReview && reviewTargetBranch === branch) {
      throw new Error('Choose a publish branch different from the repository default branch to open a pull request.');
    }

    if (lfsFiles.length) {
      if (repository.has_pages) {
        throw new Error('Git LFS is not supported by GitHub Pages repositories. Choose a regular repository for these files.');
      }
      const workerInfo = await lfsProxyRequest<{ maxUploadBytes: number }>(lfsProxyUrl, '/health');
      if (!Number.isSafeInteger(workerInfo.maxUploadBytes) || workerInfo.maxUploadBytes <= 0) {
        throw new Error('The Git LFS Worker returned an invalid upload limit.');
      }
      const tooLarge = lfsFiles.find((item) => item.file.size > workerInfo.maxUploadBytes);
      if (tooLarge) {
        throw new Error(
          `"${tooLarge.path}" exceeds this Worker’s ${formatBytes(workerInfo.maxUploadBytes)} per-file limit. Increase MAX_UPLOAD_BYTES only if your Cloudflare plan allows it, or use the CLI with Git LFS.`,
        );
      }
    }

    const ref = await getRefOrNull(`${repositoryPath}/git/ref/heads/${encodedBranch}`, token);

    let parentSha: string | null = null;
    let baseTreeSha: string | undefined;
    if (ref) {
      parentSha = ref.object.sha;
      const parentCommit = await githubRequest<unknown>(
        `${repositoryPath}/git/commits/${parentSha}`,
        token,
      );
      baseTreeSha = requireNestedSha(parentCommit, 'tree', 'commit');
    } else {
      if (repository.default_branch && repository.default_branch !== branch) {
        const defaultRef = await getRefOrNull(
          `${repositoryPath}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`,
          token,
        );
        if (defaultRef) {
          parentSha = defaultRef.object.sha;
          const parentCommit = await githubRequest<unknown>(
            `${repositoryPath}/git/commits/${parentSha}`,
            token,
          );
          baseTreeSha = requireNestedSha(parentCommit, 'tree', 'commit');
        }
      }
    }

    const regularFiles = selectedFiles.filter((item) => item.file.size <= DIRECT_UPLOAD_LIMIT);
    const entries = await createBlobs(
      lfsFiles.length ? regularFiles.filter((item) => item.path !== '.gitattributes') : regularFiles,
      repositoryPath,
      token,
      input,
    );
    if (lfsFiles.length) {
      entries.push(...await uploadLargeFiles(
        lfsFiles,
        repositoryPath,
        token,
        lfsProxyUrl,
        owner,
        repo,
        branch,
        parentSha,
        selectedFiles.find((item) => item.path === '.gitattributes'),
      ));
    }
    setStatus('Creating the commit…', 'info');
    const tree = await githubRequest<unknown>(`${repositoryPath}/git/trees`, token, {
      method: 'POST',
      body: JSON.stringify({
        ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
        tree: entries,
      }),
    });
    const treeSha = requireSha(tree, 'tree');

    const commit = await githubRequest<unknown>(`${repositoryPath}/git/commits`, token, {
      method: 'POST',
      body: JSON.stringify({
        message: `Publish ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} with RepoSend`,
        tree: treeSha,
        parents: parentSha ? [parentSha] : [],
      }),
    });
    const commitSha = requireSha(commit, 'commit');
    if (!isRecord(commit) || typeof commit.html_url !== 'string') {
      throw new Error('GitHub returned an invalid commit response (missing commit URL).');
    }

    if (ref) {
      await githubRequest(`${repositoryPath}/git/refs/heads/${encodedBranch}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commitSha, force: false }),
      });
    } else {
      await githubRequest(`${repositoryPath}/git/refs`, token, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }),
      });
    }

    let reviewUrl = '';
    if (input.openReview) {
      try {
        reviewUrl = await createGitHubPullRequest(owner, repo, branch, reviewTargetBranch, token);
      } catch (error) {
        throw new Error(
          `The branch was published, but pull request creation failed: ${error instanceof Error ? error.message : 'unexpected provider error'}`,
          { cause: error },
        );
      }
    }

    const recoveryWarning = await removeRecoveryCopy();
    tokenInput.value = '';
    setStatus(`Published ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} to ${owner}/${repo} (${branch}).`, 'success');
    appendResultLink(commit.html_url, 'View commit ↗');
    if (reviewUrl) appendResultLink(reviewUrl, 'View pull request ↗');
    if (recoveryWarning) statusElement.append(' ', document.createTextNode(recoveryWarning));
    return true;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Something went wrong while publishing. Please try again.', 'error');
    return false;
  } finally {
    setBusy(false);
  }
}

async function queueCurrentPublish(): Promise<void> {
  if (queueRunning || queueAdding) return;
  if (queuedPublishes.length >= MAX_QUEUED_PUBLISHES) {
    setStatus(`The queue is limited to ${MAX_QUEUED_PUBLISHES} jobs. Run or remove a queued job first.`, 'error');
    return;
  }
  const input = validateInput();
  if (!input) return;
  const files = [...selectedFiles];
  const keepRecoveryCopy = saveRecoveryCopyInput.checked;
  queueAdding = true;
  setBusy(false);
  try {
    if (keepRecoveryCopy && window.indexedDB) {
      await clearRecoveryCopy();
    }
    queuedPublishes.push({
      id: nextQueuedPublishId++,
      input,
      files,
      saveRecoveryCopy: keepRecoveryCopy,
    });
    if (selectedFiles.length === files.length && selectedFiles.every((item, index) => item === files[index])) {
      selectedFiles = [];
      recoveryRestored = false;
      renderFiles();
    }
    renderQueuedPublishes();
    setStatus(`Added ${input.owner}/${input.repo} (${input.branch}) to the publish queue.`, 'success');
  } catch (error) {
    setStatus(error instanceof Error ? `Could not add this job to the queue: ${error.message}` : 'Could not add this job to the queue.', 'error');
  } finally {
    queueAdding = false;
    setBusy(false);
    renderQueuedPublishes();
  }
}

async function runQueuedPublishes(): Promise<void> {
  if (queueRunning || queueAdding || !queuedPublishes.length) return;
  queueRunning = true;
  setBusy(true);
  renderQueuedPublishes();
  let completed = 0;
  try {
    while (queuedPublishes.length) {
      const job = queuedPublishes[0];
      loadQueuedPublish(job);
      setStatus(
        `Publishing queued job ${completed + 1} of ${completed + queuedPublishes.length}: ${job.input.owner}/${job.input.repo}…`,
        'info',
      );
      if (!await publish(job.input, job.files)) break;
      completedPublishes.push({
        id: job.id,
        destination: `${job.input.owner}/${job.input.repo} (${job.input.branch})`,
        links: Array.from(statusElement.querySelectorAll<HTMLAnchorElement>('.commit-link'))
          .map((link) => ({ href: link.href, label: link.textContent || 'View result' })),
      });
      if (completedPublishes.length > MAX_QUEUED_PUBLISHES) completedPublishes.shift();
      queuedPublishes.shift();
      completed += 1;
      renderQueuedPublishes();
    }
    if (!queuedPublishes.length) {
      selectedFiles = [];
      tokenInput.value = '';
      renderFiles();
      setStatus(`Published ${completed} queued job${completed === 1 ? '' : 's'}.`, 'success');
    } else {
      setStatus(
        `Queue paused after ${completed} job${completed === 1 ? '' : 's'}. The failed job remains queued; correct its details, then remove and add it again before retrying.`,
        'error',
      );
    }
  } catch (error) {
    setStatus(error instanceof Error ? `The publish queue stopped: ${error.message}` : 'The publish queue stopped unexpectedly.', 'error');
  } finally {
    queueRunning = false;
    setBusy(false);
    renderQueuedPublishes();
  }
}

function loadQueuedPublish(job: QueuedPublish): void {
  providerInput.value = job.input.provider;
  updateProviderUi();
  if (job.input.provider === 'gitlab-self-managed') {
    gitLabInstanceInput.value = job.input.gitLabApiBase.replace(/\/api\/v4$/, '');
    updateProviderUi();
  }
  tokenInput.value = job.input.token;
  repositoryInput.value = `${job.input.owner}/${job.input.repo}`;
  branchInput.value = job.input.branch;
  lfsProxyInput.value = job.input.lfsProxyUrl;
  createRepositoryInput.checked = job.input.createRepository;
  openReviewInput.checked = job.input.openReview;
  saveRecoveryCopyInput.checked = job.saveRecoveryCopy;
  selectedFiles = job.files;
  renderFiles();
}

function renderQueuedPublishes(): void {
  queuedJobsElement.replaceChildren();
  for (const result of completedPublishes) {
    const row = document.createElement('li');
    row.className = 'queued-job is-complete';
    const details = document.createElement('span');
    details.className = 'queued-job-details';
    details.textContent = `Published · ${result.destination}`;
    row.append(details);
    for (const resultLink of result.links) {
      const link = document.createElement('a');
      link.href = resultLink.href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.className = 'commit-link';
      link.textContent = resultLink.label;
      row.append(link);
    }
    queuedJobsElement.append(row);
  }
  for (const [index, job] of queuedPublishes.entries()) {
    const row = document.createElement('li');
    row.className = 'queued-job';
    const details = document.createElement('span');
    details.className = 'queued-job-details';
    const size = job.files.reduce((total, item) => total + item.file.size, 0);
    details.textContent = `${index + 1}. ${providerName(job.input.provider)} · ${job.input.owner}/${job.input.repo} · ${job.input.branch} · ${job.files.length} file${job.files.length === 1 ? '' : 's'} · ${formatBytes(size)}`;
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'text-button queued-job-remove';
    removeButton.textContent = 'Remove';
    removeButton.disabled = queueRunning;
    removeButton.addEventListener('click', () => {
      if (queueRunning) return;
      queuedPublishes = queuedPublishes.filter((item) => item.id !== job.id);
      renderQueuedPublishes();
    });
    row.append(details, removeButton);
    queuedJobsElement.append(row);
  }
  queueCurrentButton.disabled = queueRunning || queueAdding || queuedPublishes.length >= MAX_QUEUED_PUBLISHES;
  runQueueButton.disabled = queueRunning || queueAdding || !queuedPublishes.length;
  runQueueButton.textContent = `Run queue (${queuedPublishes.length})`;
}

async function publishToGitLab(input: PublishInput): Promise<void> {
  const { owner, repo, branch, token } = input;
  const repositoryPath = `/projects/${encodeURIComponent(`${owner}/${repo}`)}`;
  let project: unknown;
  try {
    const projectResponse = await gitLabRequest<unknown>(repositoryPath, token);
    project = projectResponse.data;
  } catch (error) {
    if (!input.createRepository || !(error instanceof GitLabApiError) || error.status !== 404) throw error;
    project = await ensureGitLabProject(owner, repo, token);
  }
  if (
    !isRecord(project)
    || typeof project.id !== 'number'
    || !Number.isSafeInteger(project.id)
    || project.id <= 0
  ) {
    throw new Error('GitLab returned an invalid project response.');
  }

  const branchExists = await gitLabBranchExists(repositoryPath, branch, token);
  const defaultBranch = typeof project.default_branch === 'string' ? project.default_branch : '';
  if (input.openReview && defaultBranch === branch) {
    throw new Error('Choose a publish branch different from the repository default branch to open a merge request.');
  }
  const baseBranch = branchExists ? branch : defaultBranch;
  if (!baseBranch) {
    throw new Error('This GitLab project has no default branch yet. Create its initial commit in GitLab or with the RepoSend CLI, then retry.');
  }

  const targetPaths = new Set(selectedFiles.map((item) => item.path));
  const existingPaths = await getGitLabExistingPaths(repositoryPath, baseBranch, targetPaths, token);
  const actions: Array<{
    action: 'create' | 'update';
    file_path: string;
    encoding: 'base64';
    content: string;
  }> = [];
  const totalBytes = selectedFiles.reduce((total, item) => total + item.file.size, 0);
  let completedBytes = 0;

  for (const [index, item] of selectedFiles.entries()) {
    const encodedChunks = await toBase64Chunks(item.file, (processedBytes) => {
      setStatus(
        `Preparing GitLab file ${index + 1} of ${selectedFiles.length} · ${formatBytes(processedBytes)} of ${formatBytes(item.file.size)}: ${item.path}`,
        'info',
      );
    });
    actions.push({
      action: existingPaths.has(item.path) ? 'update' : 'create',
      file_path: item.path,
      encoding: 'base64',
      content: encodedChunks.join(''),
    });
    completedBytes += item.file.size;
    setStatus(
      `Prepared ${index + 1} of ${selectedFiles.length} GitLab files · ${formatBytes(completedBytes)} of ${formatBytes(totalBytes)}`,
      'info',
    );
  }

  setStatus('Creating the GitLab commit…', 'info');
  const commitResponse = await gitLabRequest<unknown>(
    `${repositoryPath}/repository/commits`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        branch,
        commit_message: `Publish ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} with RepoSend`,
        actions,
        ...(!branchExists ? { start_branch: baseBranch } : {}),
      }),
    },
  );
  const commit = commitResponse.data;
  if (!isRecord(commit) || typeof commit.id !== 'string' || typeof commit.web_url !== 'string') {
    throw new Error('GitLab returned an invalid commit response (missing commit ID or URL).');
  }

  let commitUrl: URL;
  try {
    commitUrl = new URL(commit.web_url);
  } catch {
    throw new Error('GitLab returned an invalid commit URL.');
  }
  if (
    commitUrl.origin !== new URL(input.gitLabApiBase).origin
    || commitUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(commitUrl.hostname)
    || commitUrl.username
    || commitUrl.password
  ) {
    throw new Error('GitLab returned an unexpected commit URL.');
  }

  let reviewUrl = '';
  if (input.openReview) {
    if (!defaultBranch) throw new Error('GitLab did not report a default branch, so a merge request cannot be created.');
    try {
      reviewUrl = await createGitLabMergeRequest(repositoryPath, branch, defaultBranch, token);
    } catch (error) {
      throw new Error(
        `The branch was published, but merge request creation failed: ${error instanceof Error ? error.message : 'unexpected provider error'}`,
        { cause: error },
      );
    }
  }

  const recoveryWarning = await removeRecoveryCopy();
  tokenInput.value = '';
  setStatus(
    `Published ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} to ${owner}/${repo} (${branch}).`,
    'success',
  );
  appendResultLink(commitUrl.href, 'View commit ↗');
  if (reviewUrl) appendResultLink(reviewUrl, 'View merge request ↗');
  if (recoveryWarning) statusElement.append(' ', document.createTextNode(recoveryWarning));
}

async function gitLabBranchExists(repositoryPath: string, branch: string, token: string): Promise<boolean> {
  try {
    await gitLabRequest(
      `${repositoryPath}/repository/branches/${encodeURIComponent(branch)}`,
      token,
    );
    return true;
  } catch (error) {
    if (error instanceof GitLabApiError && error.status === 404) return false;
    throw error;
  }
}

async function getGitLabExistingPaths(
  repositoryPath: string,
  branch: string,
  targetPaths: Set<string>,
  token: string,
): Promise<Set<string>> {
  const existingPaths = new Set<string>();
  const pageSize = 100;
  let page = 1;

  while (existingPaths.size < targetPaths.size) {
    if (page > 1000) {
      throw new Error('GitLab returned more than 100,000 tree entries while checking selected paths. Use the RepoSend CLI for this repository.');
    }
    const query = new URLSearchParams({
      ref: branch,
      recursive: 'true',
      per_page: String(pageSize),
      page: String(page),
    });
    setStatus(`Checking GitLab repository files (page ${page})…`, 'info');
    const result = await gitLabRequest<unknown>(
      `${repositoryPath}/repository/tree?${query.toString()}`,
      token,
    );
    if (!Array.isArray(result.data)) {
      throw new Error('GitLab returned an invalid repository tree response.');
    }
    for (const entry of result.data) {
      if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.type !== 'string') {
        throw new Error('GitLab returned an invalid repository tree entry.');
      }
      if (entry.type === 'blob' && targetPaths.has(entry.path)) existingPaths.add(entry.path);
    }
    if (existingPaths.size === targetPaths.size) break;

    const nextPage = result.response.headers.get('X-Next-Page');
    if (nextPage) {
      const parsedPage = Number(nextPage);
      if (!Number.isSafeInteger(parsedPage) || parsedPage <= page) {
        throw new Error('GitLab returned invalid repository pagination information.');
      }
      page = parsedPage;
    } else if (result.data.length === pageSize) {
      page += 1;
    } else {
      break;
    }
  }

  return existingPaths;
}

async function getRefOrNull(path: string, token: string): Promise<{ object: { sha: string } } | null> {
  try {
    const ref = await githubRequest<unknown>(path, token);
    return { object: { sha: requireNestedSha(ref, 'object', 'branch reference') } };
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message.startsWith('Repository or branch not found')
        || error.message === 'Git Repository is empty.'
      )
    ) return null;
    throw error;
  }
}

function requireNestedSha(response: unknown, property: string, responseName: string): string {
  if (!isRecord(response)) {
    throw new Error(`GitHub returned an invalid ${responseName} response (missing SHA).`);
  }
  return requireSha(response[property], responseName);
}

function requireSha(response: unknown, responseName: string): string {
  if (!isRecord(response) || typeof response.sha !== 'string' || !response.sha.trim()) {
    throw new Error(`GitHub returned an invalid ${responseName} response (missing SHA).`);
  }
  return response.sha;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createBlobs(
  files: SelectedFile[],
  repositoryPath: string,
  token: string,
  input: PublishInput,
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  let completed = 0;
  let completedBytes = 0;
  const totalBytes = files.reduce((total, item) => total + item.file.size, 0);

  for (const [index, item] of files.entries()) {
    const checkpointSha = await getBlobCheckpoint(item, input);
    if (checkpointSha) {
      entries.push({ path: item.path, mode: '100644', type: 'blob', sha: checkpointSha });
      completed += 1;
      completedBytes += item.file.size;
      setStatus(
        `Resumed ${completed} of ${files.length} files · ${formatBytes(completedBytes)} of ${formatBytes(totalBytes)}`,
        'info',
      );
      continue;
    }
    const encodedChunks = await toBase64Chunks(item.file, (processedBytes) => {
      setStatus(
        `Preparing file ${index + 1} of ${files.length} · ${formatBytes(processedBytes)} of ${formatBytes(item.file.size)}: ${item.path}`,
        'info',
      );
    });
    setStatus(
      `Uploading file ${index + 1} of ${files.length} (${formatBytes(item.file.size)}): ${item.path}`,
      'info',
    );
    const blob = await githubRequest<unknown>(`${repositoryPath}/git/blobs`, token, {
      method: 'POST',
      body: createBlobRequestBody(encodedChunks),
    });
    const sha = requireSha(blob, 'blob');
    await saveBlobCheckpoint(item, input, sha);
    entries.push({ path: item.path, mode: '100644', type: 'blob', sha });
    completed += 1;
    completedBytes += item.file.size;
    setStatus(
      `Uploaded ${completed} of ${files.length} files · ${formatBytes(completedBytes)} of ${formatBytes(totalBytes)}`,
      'info',
    );
  }

  return entries;
}

async function uploadLargeFiles(
  files: SelectedFile[],
  repositoryPath: string,
  token: string,
  proxyUrl: string,
  owner: string,
  repo: string,
  branch: string,
  parentSha: string | null,
  selectedAttributes?: SelectedFile,
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const totalBytes = files.reduce((total, item) => total + item.file.size, 0);
  let uploadedBytes = 0;
  const existingAttributes = await readGitAttributes(
    repositoryPath,
    token,
    parentSha,
    selectedAttributes,
  );
  const attributesContent = addLfsAttributes(
    existingAttributes,
    files.map((item) => item.path),
  );

  for (const [index, item] of files.entries()) {
    const oid = await hashFile(item.file, (processedBytes) => {
      setStatus(
        `Hashing LFS file ${index + 1} of ${files.length} · ${formatBytes(processedBytes)} of ${formatBytes(item.file.size)}: ${item.path}`,
        'info',
      );
    });
    const result = await lfsProxyRequest<{ object: LfsObject }>(proxyUrl, '/lfs/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ owner, repo, branch, oid, size: item.file.size }),
    });
    const lfsObject = result.object;
    if (!lfsObject) throw new Error('The Git LFS Worker returned an invalid object response.');
    if (lfsObject.error) throw new Error(lfsObject.error.message || 'GitHub LFS rejected this file.');
    if (lfsObject.oid !== oid || lfsObject.size !== item.file.size) {
      throw new Error(`GitHub LFS returned mismatched metadata for "${item.path}".`);
    }

    if (lfsObject.actions?.upload) {
      let uploadUrl: URL;
      try {
        uploadUrl = new URL(lfsObject.actions.upload.href);
      } catch {
        throw new Error('The Git LFS Worker returned an invalid upload URL.');
      }
      if (uploadUrl.origin !== proxyUrl || uploadUrl.pathname !== '/lfs/upload') {
        throw new Error('The Git LFS Worker returned an unexpected upload URL.');
      }
      if (!lfsObject.actions.upload.header?.['X-RepoSend-LFS-Ticket']) {
        throw new Error('The Git LFS Worker did not return an upload ticket.');
      }
      setStatus(`Uploading LFS file ${index + 1} of ${files.length} (${formatBytes(item.file.size)}): ${item.path}`, 'info');
      await lfsProxyRequest<{ uploaded: boolean }>(proxyUrl, '/lfs/upload', {
        method: 'PUT',
        headers: lfsObject.actions.upload.header,
        body: item.file,
      });
    }

    const pointer = [
      'version https://git-lfs.github.com/spec/v1',
      `oid sha256:${oid}`,
      `size ${item.file.size}`,
      '',
    ].join('\n');
    entries.push(await createTextBlob(item.path, pointer, repositoryPath, token));
    uploadedBytes += item.file.size;
    setStatus(
      `Uploaded ${index + 1} of ${files.length} LFS files · ${formatBytes(uploadedBytes)} of ${formatBytes(totalBytes)}`,
      'info',
    );
  }

  if (selectedAttributes || attributesContent !== existingAttributes) {
    entries.push(await createTextBlob('.gitattributes', attributesContent, repositoryPath, token));
  }
  return entries;
}

async function hashFile(file: File, onProgress: (processedBytes: number) => void): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_SIZE) {
    const bytes = new Uint8Array(await file.slice(offset, offset + HASH_CHUNK_SIZE).arrayBuffer());
    hash.update(bytes);
    if (offset % (HASH_CHUNK_SIZE * 8) === 0 || offset + HASH_CHUNK_SIZE >= file.size) {
      onProgress(Math.min(file.size, offset + HASH_CHUNK_SIZE));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readGitAttributes(
  repositoryPath: string,
  token: string,
  parentSha: string | null,
  selectedAttributes?: SelectedFile,
): Promise<string> {
  if (selectedAttributes) return await selectedAttributes.file.text();
  if (!parentSha) return '';

  let response: { content?: string; encoding?: string };
  try {
    response = await githubRequest<{ content?: string; encoding?: string }>(
      `${repositoryPath}/contents/.gitattributes?ref=${encodeURIComponent(parentSha)}`,
      token,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Repository or branch not found')) return '';
    throw error;
  }
  if (response.encoding !== 'base64' || !response.content) {
    throw new Error('Could not read the repository .gitattributes file to add Git LFS rules.');
  }
  const decoded = atob(response.content.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(decoded, (character) => character.charCodeAt(0)));
}

function addLfsAttributes(current: string, paths: string[]): string {
  const existingLines = new Set(current.split(/\r?\n/));
  const newRules = paths
    .map(gitLfsAttributeRule)
    .filter((rule) => !existingLines.has(rule));
  if (!newRules.length) return current;
  const prefix = current && !current.endsWith('\n') ? `${current}\n` : current;
  return `${prefix}${newRules.join('\n')}\n`;
}

function gitLfsAttributeRule(path: string): string {
  let pattern = '"';
  for (const character of path) {
    if (character === '\\') pattern += '\\'.repeat(3);
    else if ('*?[]'.includes(character)) pattern += '\\\\';
    else if (character === '"') pattern += '\\';
    pattern += character;
  }
  return `${pattern}" filter=lfs diff=lfs merge=lfs -text`;
}

async function createTextBlob(
  path: string,
  content: string,
  repositoryPath: string,
  token: string,
): Promise<TreeEntry> {
  const blob = await githubRequest<unknown>(`${repositoryPath}/git/blobs`, token, {
    method: 'POST',
    body: JSON.stringify({ content, encoding: 'utf-8' }),
  });
  return { path, mode: '100644', type: 'blob', sha: requireSha(blob, 'blob') };
}

function setBusy(isBusy: boolean): void {
  publishBusy = isBusy;
  const controlsBusy = isBusy || queueRunning || queueAdding;
  publishButton.disabled = controlsBusy;
  publishButtonLabel.textContent = queueAdding
    ? 'Adding to queue…'
    : controlsBusy
      ? 'Publishing…'
      : `Publish to ${providerName()}`;
  providerInput.disabled = controlsBusy;
  tokenInput.disabled = controlsBusy;
  repositoryInput.disabled = controlsBusy;
  verifyAccessButton.disabled = controlsBusy;
  branchInput.disabled = controlsBusy;
  lfsProxyInput.disabled = controlsBusy;
  createRepositoryInput.disabled = controlsBusy;
  openReviewInput.disabled = controlsBusy;
  saveRecoveryCopyInput.disabled = controlsBusy || !window.indexedDB;
  filePicker.disabled = controlsBusy;
  folderPicker.disabled = controlsBusy;
  queueCurrentButton.disabled = controlsBusy || queuedPublishes.length >= MAX_QUEUED_PUBLISHES;
  runQueueButton.disabled = controlsBusy || !queuedPublishes.length;
  document.querySelector<HTMLButtonElement>('#choose-files')!.disabled = controlsBusy;
  document.querySelector<HTMLButtonElement>('#choose-folder')!.disabled = controlsBusy;
  document.querySelectorAll<HTMLButtonElement>('.clear-files').forEach((button) => {
    button.disabled = controlsBusy;
  });
  document.querySelectorAll<HTMLButtonElement>('.queued-job-remove').forEach((button) => {
    button.disabled = controlsBusy;
  });
}
