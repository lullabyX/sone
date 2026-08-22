# Upstream

This directory is a Git subtree import of Sone's `tiddl-headless` fork.

- Fork: `https://github.com/mikelexp/tiddl.git`
- Fork branch: `sone-integration`
- Imported commit: `ce236b73786629f8bbfc4e205d5ba914b6c6ae66`
- Upstream base: `https://github.com/oskvr37/tiddl`, `v3.4.4`

The fork carries Sone-specific download behavior:

- JSONL event schema v1 for desktop consumers.
- Byte-level download progress totals.
- Process-group cancellation that also stops converters.
- Cleanup of `.tiddl-part-*` temporary files on interruption.

## Updating

Do not merge upstream directly into Sone. First create a temporary integration
branch in the fork, merge the desired upstream release, retain and test the
Sone-specific patches, and push the verified result to `sone-integration`.

From the Sone repository, import that verified commit with:

```sh
git remote add tiddl-sone https://github.com/mikelexp/tiddl.git
git fetch tiddl-sone sone-integration
git subtree pull --prefix=third_party/tiddl tiddl-sone sone-integration --squash
git remote remove tiddl-sone
```

Run the subtree's Python tests and Sone's download integration tests before
committing the subtree update. Do not edit generated Nuitka output in this
directory.
