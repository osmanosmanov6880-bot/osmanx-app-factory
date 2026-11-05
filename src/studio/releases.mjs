import { createHash } from 'node:crypto';
import { bad } from '../common/http.mjs';
import { id, now, shortText } from '../common/security.mjs';
import { withTransaction } from '../common/db.mjs';

export const hashJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function publicRelease(row) {
  return { id:row.id,projectId:row.project_id,sequence:row.sequence,
    snapshotSha256:row.snapshot_sha256,notes:row.notes,createdAt:row.created_at };
}
export function listReleases(db,projectId) {
  return db.prepare('SELECT id,project_id,sequence,snapshot_sha256,notes,created_at FROM project_releases WHERE project_id=? ORDER BY sequence DESC LIMIT 100')
    .all(projectId).map(publicRelease);
}
export function releaseFromDb(db,projectId,releaseId) {
  const row=db.prepare('SELECT * FROM project_releases WHERE id=? AND project_id=?').get(releaseId,projectId);
  if(!row)bad(404,'Release not found');
  const snapshot=JSON.parse(row.snapshot_json);
  if(hashJson(snapshot)!==row.snapshot_sha256)bad(500,'Release snapshot integrity failure');
  return {release:publicRelease(row),project:snapshot};
}
export function createRelease(db,project,userId,notes='') {
  notes=shortText(notes,'Release notes',240,false);
  const snapshot=structuredClone(project);
  const digest=hashJson(snapshot);
  return withTransaction(db,()=>{
    const previous=db.prepare('SELECT sequence,snapshot_sha256 FROM project_releases WHERE project_id=? ORDER BY sequence DESC LIMIT 1').get(project.id);
    if(previous?.snapshot_sha256===digest)bad(409,'No project changes since the last release');
    const sequence=(previous?.sequence||0)+1;
    const newId=id(),created=now();
    db.prepare('INSERT INTO project_releases(id,project_id,sequence,snapshot_json,snapshot_sha256,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(newId,project.id,sequence,JSON.stringify(snapshot),digest,notes,userId,created);
    return {id:newId,projectId:project.id,sequence,snapshotSha256:digest,notes,createdAt:created};
  });
}
