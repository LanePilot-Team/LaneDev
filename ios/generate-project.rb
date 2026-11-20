# Regeneration only: requires the xcodeproj gem (bundled with CocoaPods).
# Once web assets are staged, Xcode builds without Ruby, CocoaPods or Node.
require 'xcodeproj'
root = File.expand_path(__dir__)
project = Xcodeproj::Project.new(File.join(root, 'LaneDev.xcodeproj'))
minimum_ios = '16.4'
app = project.new_target(:application, 'LaneDev', :ios, minimum_ios)
package = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
package.repositoryURL = 'https://github.com/googlemaps/ios-places-sdk.git'
package.requirement = { 'kind' => 'exactVersion', 'version' => '10.15.0' }
project.root_object.package_references << package
places = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
places.package = package
places.product_name = 'GooglePlacesSwift'
app.package_product_dependencies << places
linked_places = project.new(Xcodeproj::Project::Object::PBXBuildFile)
linked_places.product_ref = places
app.frameworks_build_phase.files << linked_places
places_config = project.main_group.new_file('GooglePlaces.xcconfig')
group = project.main_group.new_group('LaneDev', 'LaneDev')
Dir[File.join(root, 'LaneDev', '*.swift')].sort.each { |f| app.source_build_phase.add_file_reference(group.new_file(File.basename(f))) }
app.resources_build_phase.add_file_reference(group.new_file('Bridge.js'))
assets = project.main_group.new_file('.web/$(LANE_WEB_MODE)/public')
assets.last_known_file_type = 'folder'
app.resources_build_phase.add_file_reference(assets)
verify = app.new_shell_script_build_phase('Verify web asset mode')
verify.input_paths = ['$(SRCROOT)/tools/verify-web-mode.sh', '$(SRCROOT)/.web/$(LANE_WEB_MODE)/public/client-policy.json']
verify.shell_script = '/bin/sh "$SCRIPT_INPUT_FILE_0"'
verify.always_out_of_date = '1'
group.new_file('Info.plist')
app.build_configurations.each do |c|
  c.base_configuration_reference = places_config
  c.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'tw.lanepilot.lanedev.ios',
    'INFOPLIST_FILE' => 'LaneDev/Info.plist',
    'SWIFT_VERSION' => '5.0',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'CODE_SIGN_STYLE' => 'Automatic',
    'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES',
    'LANE_WEB_MODE' => 'ios-release',
    'SUPPORTS_MACCATALYST' => 'NO',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => c.name == 'Debug' ? 'DEBUG' : '',
  })
  if c.name == 'Debug'
    c.build_settings['LANE_WEB_MODE[sdk=iphonesimulator*]'] = 'ios-simulator'
    c.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS[sdk=iphonesimulator*]'] = 'DEBUG LANE_SIMULATOR_NAVIGATION'
  end
end
tests = project.new_target(:unit_test_bundle, 'LaneDevTests', :ios, minimum_ios)
test_group = project.main_group.new_group('LaneDevTests', 'LaneDevTests')
Dir[File.join(root, 'LaneDevTests', '*.swift')].sort.each { |f| tests.source_build_phase.add_file_reference(test_group.new_file(File.basename(f))) }
tests.add_dependency(app)
tests.build_configurations.each do |c|
  c.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'tw.lanepilot.lanedev.ios.tests',
    'SWIFT_VERSION' => '5.0', 'GENERATE_INFOPLIST_FILE' => 'YES',
    'TEST_HOST' => '$(BUILT_PRODUCTS_DIR)/LaneDev.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/LaneDev',
    'BUNDLE_LOADER' => '$(TEST_HOST)', 'TARGETED_DEVICE_FAMILY' => '1,2',
  })
end
project.save
ui_tests = project.new_target(:ui_test_bundle, 'LaneDevUITests', :ios, minimum_ios)
ui_group = project.main_group.new_group('LaneDevUITests', 'LaneDevUITests')
Dir[File.join(root, 'LaneDevUITests', '*.swift')].sort.each { |f| ui_tests.source_build_phase.add_file_reference(ui_group.new_file(File.basename(f))) }
ui_tests.add_dependency(app)
ui_tests.build_configurations.each do |c|
  c.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'tw.lanepilot.lanedev.ios.uitests',
    'SWIFT_VERSION' => '5.0', 'GENERATE_INFOPLIST_FILE' => 'YES',
    'TEST_TARGET_NAME' => 'LaneDev', 'TARGETED_DEVICE_FAMILY' => '1,2',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => c.name == 'Debug' ? 'DEBUG' : '',
  })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.set_launch_target(app)
scheme.add_test_target(tests)
scheme.add_test_target(ui_tests)
scheme.test_action.build_configuration = 'Debug'
scheme.save_as(project.path, 'LaneDev', true)
release = Xcodeproj::XCScheme.new
release.add_build_target(app)
release.set_launch_target(app)
release.add_test_target(ui_tests)
release.test_action.build_configuration = 'Release'
release.launch_action.build_configuration = 'Release'
release.launch_action.allow_location_simulation = false
release.save_as(project.path, 'LaneDevRelease', true)
