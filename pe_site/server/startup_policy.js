// Controls startup side effects only; it does not change request-handler behavior.
const required={
  users:['id','email','password_hash','role','active'],
  inventory:['id','quantity','regulated','public_visible','image_url','image_urls','price_cents'],
  distributor_catalog:['supplier','supplier_item_id','status','review_status'],
  chattanooga_reference:['supplier_item_id','category']
};
export async function prepareStartup({mode='normal',pool,initializeSchema,bootstrapAdmin}){
  if(!['normal','read-only'].includes(mode))throw new Error('Invalid startup mode');
  if(mode==='normal'){
    await initializeSchema();await bootstrapAdmin();
    return {allowImageMigration:true};
  }
  // Fail closed if the existing database is unavailable or lacks core columns.
  // Never attempt a schema repair or bootstrap write in read-only startup mode.
  const {rows}=await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[])",[Object.keys(required)]);
  const found=new Set(rows.map(r=>r.table_name+'.'+r.column_name));
  if(Object.entries(required).some(([table,columns])=>columns.some(c=>!found.has(table+'.'+c))))
    throw new Error('Existing database is not ready for read-only startup');
  return {allowImageMigration:false};
}
