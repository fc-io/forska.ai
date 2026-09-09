include_guard(GLOBAL)
cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL set_target_properties
  duckdb_main_capi_v2 PROPERTIES UNITY_BUILD ON UNITY_BUILD_BATCH_SIZE 0)
