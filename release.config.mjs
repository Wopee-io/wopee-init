export default {
  tagFormat: "v${version}",
  branches: ["main"],
  plugins: [
    ["@semantic-release/commit-analyzer", { preset: "angular" }],
    "@semantic-release/release-notes-generator",
    // Publishes with provenance (publishConfig.provenance) through npm trusted publishing.
    ["@semantic-release/npm", { npmPublish: true }],
    [
      "@semantic-release/github",
      { successCommentCondition: false, failCommentCondition: false },
    ],
    ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "package.json", "package-lock.json"],
        message:
          "chore(release): @wopee-io/init v${nextRelease.version}\n\n${nextRelease.notes}",
      },
    ],
  ],
};
