// Imported before anything of src/: a proof of work cheap enough for thousands of
// requests per test. A test that needs another value sets it before importing this.

process.env.DN_POW_MEMBER_BASE ??= '8';
process.env.DN_POW_STRANGER_BASE ??= '64';
