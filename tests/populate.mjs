// Fills a sandbox Stash with test data: scan, then studios, performers, tags, a group
// and markers, with big sets on the first of each so their pages need several batches.
export async function populate(port) {
  const url = `http://127.0.0.1:${port}/graphql`;
  async function gql(query, variables = {}) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitJobs() {
    for (;;) {
      const d = await gql("{ jobQueue { id status } }");
      if (!d.jobQueue || d.jobQueue.length === 0) return;
      await sleep(1000);
    }
  }
  
  await gql(`mutation { metadataScan(input: { scanGenerateCovers: true, scanGenerateThumbnails: true }) }`);
  await waitJobs();
  const counts = await gql("{ findScenes { count } findImages { count } findGalleries { count } }");
  console.log("scanned", JSON.stringify(counts));
  
  const sceneIds = (await gql(`{ findScenes(filter: { per_page: -1, sort: "path", direction: ASC }) { scenes { id } } }`)).findScenes.scenes.map((s) => s.id);
  const imageIds = (await gql(`{ findImages(filter: { per_page: -1, sort: "path", direction: ASC }) { images { id } } }`)).findImages.images.map((s) => s.id);
  const galleryIds = (await gql(`{ findGalleries(filter: { per_page: -1 }) { galleries { id } } }`)).findGalleries.galleries.map((s) => s.id);
  
  const mk = async (m, name, extra = "") => (await gql(`mutation { ${m}(input: { name: "${name}" ${extra} }) { id } }`))[m].id;
  const studios = [], performers = [], tags = [];
  for (let i = 1; i <= 20; i++) studios.push(await mk("studioCreate", `Studio ${i}`));
  for (let i = 1; i <= 40; i++) performers.push(await mk("performerCreate", `Performer ${i}`));
  for (let i = 1; i <= 40; i++) tags.push(await mk("tagCreate", `Tag ${i}`));
  const group = (await gql(`mutation { groupCreate(input: { name: "Group 1" }) { id } }`)).groupCreate.id;
  for (let i = 2; i <= 18; i++) await gql(`mutation { groupCreate(input: { name: "Group ${i}" }) { id } }`);
  
  // big sets on the first of each, so their detail-page lists need several batches
  await gql(`mutation($ids: [ID!], $s: ID, $p: [ID!], $t: [ID!], $g: [ID!]) { bulkSceneUpdate(input: { ids: $ids, studio_id: $s, performer_ids: { ids: $p, mode: ADD }, tag_ids: { ids: $t, mode: ADD }, group_ids: { ids: $g, mode: ADD } }) { id } }`,
    { ids: sceneIds.slice(0, 60), s: studios[0], p: [performers[0]], t: [tags[0]], g: [group] });
  await gql(`mutation($ids: [ID!], $s: ID, $p: [ID!]) { bulkSceneUpdate(input: { ids: $ids, studio_id: $s, performer_ids: { ids: $p, mode: ADD } }) { id } }`,
    { ids: sceneIds.slice(60), s: studios[1], p: [performers[1]] });
  await gql(`mutation($ids: [ID!], $p: [ID!], $t: [ID!], $s: ID) { bulkImageUpdate(input: { ids: $ids, studio_id: $s, performer_ids: { ids: $p, mode: ADD }, tag_ids: { ids: $t, mode: ADD } }) { id } }`,
    { ids: imageIds, p: [performers[0]], t: [tags[0]], s: studios[0] });
  await gql(`mutation($ids: [ID!], $p: [ID!], $s: ID) { bulkGalleryUpdate(input: { ids: $ids, studio_id: $s, performer_ids: { ids: $p, mode: ADD } }) { id } }`,
    { ids: galleryIds, p: [performers[0]], s: studios[0] });
  // a spread so performer / tag / studio lists have counts to sort by
  for (let i = 0; i < sceneIds.length; i++) {
    await gql(`mutation($id: ID!, $p: [ID!], $t: [ID!]) { sceneUpdate(input: { id: $id, performer_ids: $p, tag_ids: $t, rating100: ${(i * 13) % 100} }) { id } }`,
      { id: sceneIds[i], p: [performers[0], performers[1 + (i % 39)]], t: [tags[0], tags[1 + (i % 39)]] });
  }
  for (let i = 0; i < 40; i++) {
    await gql(`mutation($s: ID!, $t: ID!) { sceneMarkerCreate(input: { scene_id: $s, primary_tag_id: $t, seconds: 1, title: "Marker ${i + 1}" }) { id } }`,
      { s: sceneIds[i], t: tags[1 + (i % 5)] });
  }
  await gql(`mutation { metadataGenerate(input: { markers: true, markerImagePreviews: false, markerScreenshots: true, previews: true, sprites: false }) }`);
  await waitJobs();
  console.log("done", JSON.stringify(await gql("{ findScenes { count } findImages { count } findGalleries { count } findPerformers { count } findStudios { count } findTags { count } findGroups { count } findSceneMarkers { count } }")));
}
