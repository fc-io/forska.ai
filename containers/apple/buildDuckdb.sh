#!/bin/sh
set -eu
cd /opt/duckdb-source
patch_path=/opt/forska-build/duckdb-checkpoint-backport.patch
echo '9d9a2adbcc22891e4f4aada3d0235da7fb154f7137b9ce01d4c64aa9bf069b70  /opt/forska-build/duckdb-checkpoint-backport.patch' | sha256sum --check
patch_sha=$(sha256sum "$patch_path" | cut -d ' ' -f 1)
git apply --check "$patch_path"
git apply "$patch_path"
include_patch=/opt/forska-build/duckdb-nonunity-includes.patch
echo '0de036117f2b40246c2629b2a2fa798f9b6e7c04e18a653057583c1a866300ce  /opt/forska-build/duckdb-nonunity-includes.patch' | sha256sum --check
git apply --check "$include_patch"
git apply "$include_patch"
build_key=$(sha256sum /tmp/duckdb-source.tar.gz "$patch_path" "$include_patch" | sha256sum | cut -d ' ' -f 1)
build_dir="build/release/$build_key"
cmake -S . -B "$build_dir" -G Ninja \
  -DCMAKE_C_COMPILER_LAUNCHER=ccache \
  -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_UNITTESTS=ON \
  -DENABLE_UNITTEST_CPP_TESTS=OFF \
  -DCMAKE_SHARED_LINKER_FLAGS=-fuse-ld=lld \
  -DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=lld \
  -DBUILD_SHELL=OFF \
  -DDISABLE_UNITY=ON \
  -DENABLE_EXTENSION_AUTOLOADING=ON \
  -DENABLE_EXTENSION_AUTOINSTALL=ON \
  -DDUCKDB_EXTENSION_CONFIGS=.github/config/bundled_extensions.cmake \
  "-DOVERRIDE_GIT_DESCRIBE=v1.5.5-0-g${patch_sha}"
cmake --build "$build_dir" --target duckdb unittest --parallel 1
mkdir -p /opt/forska-duckdb
"$build_dir/test/unittest" 'test/sql/delete/bulk_delete_version_info_memory.test,test/sql/delete/delete_compression_after_restart.test,test/sql/delete/delete_compression_blocked_by_old_snapshot.test,test/sql/delete/full_vector_delete_conflict.test,test/sql/delete/full_vector_delete_rollback.test,test/sql/delete/piecemeal_delete_checkpoint_compress.test_slow,test/sql/storage/full_vector_delete_checkpoint.test,test/sql/storage/piecemeal_delete_checkpoint_compress.test,test/sql/delete/masked_vector_further_delete.test,test/sql/delete/masked_vector_rollback.test,test/sql/delete/partial_delete_version_info_memory.test,test/sql/storage/partial_delete_checkpoint_mask.test,test/sql/storage/partial_delete_pending_compress.test' --reporter junit --out /opt/forska-duckdb/upstream-tests.xml
python3 - <<'VERIFY'
import xml.etree.ElementTree as ET
root = ET.parse('/opt/forska-duckdb/upstream-tests.xml').getroot()
cases = root.findall('.//testcase')
assert len(cases) == 13, f'Expected all 13 upstream cases, got {len(cases)}'
assert not root.findall('.//failure') and not root.findall('.//error')
assert not root.findall('.//skipped'), 'Upstream regression cases must not be skipped'
print('DuckDB backport: all 13 upstream regression cases passed')
VERIFY
cp "$build_dir/src/libduckdb.so" /opt/forska-duckdb/libduckdb.so
python3 - "$patch_sha" <<'PY'
import hashlib, json, pathlib, sys
library = pathlib.Path('/opt/forska-duckdb/libduckdb.so')
manifest = {
    'engineVersion': '1.5.5',
    'sourceCommit': 'd8cdaa33fda8df955cc76ef58a280f68f4cd43fa',
    'upstreamFixes': ['929a0e336b2dfdc2653b5c833bd76af189f29c37', '1da80a4a3adef9053fb665864734debf1407a521'],
    'backportSha256': sys.argv[1],
    'nonUnityIncludePatchSha256': '0de036117f2b40246c2629b2a2fa798f9b6e7c04e18a653057583c1a866300ce',
    'librarySha256': hashlib.sha256(library.read_bytes()).hexdigest(),
    'scope': 'Apple Linux ARM64 container only; host package versions unchanged',
}
pathlib.Path('/opt/forska-duckdb/provenance.json').write_text(json.dumps(manifest, sort_keys=True) + '\n')
PY
