import { describe, expect, it, vi } from 'vitest';
// Both builders read the tenant's deployment history through the db
// abstraction; the hosted one reaches it via getDatabase().
const shared = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db', () => ({ getDatabase: () => shared.db }));
import { buildDeploymentConfigFromAdapter, buildDeploymentConfigForApp } from './build-deployment-config';
import { DEFAULT_PSADT_CONFIG } from '@/types/psadt';
import type { DatabaseAdapter } from '@/lib/db/types';

describe('fixed custom detection storage parity', () => {
  it('round trips exact rules and their flag through both deployment config builders', async () => {
    const rules = [{type:'registry',keyPath:'HKEY_LOCAL_MACHINE\\Vendor',valueName:'Version',detectionType:'version',operator:'equal',detectionValue:'1.2.3'}];
    const job = {display_name:'Vendor App',publisher:'Vendor',architecture:'x64',installer_type:'exe',install_command:'app.exe /S',uninstall_command:'app.exe /X',install_scope:'machine',detection_rules:rules,package_config:{psadtConfig:{...DEFAULT_PSADT_CONFIG,customDetection:true,detectionRules:rules}}};
    const history = {id:'history',packaging_job_id:'job',winget_id:'Vendor.App'};
    const db = {uploadHistory:{getByTenantId:vi.fn().mockResolvedValue([history])},jobs:{getById:vi.fn().mockResolvedValue(job)}} as unknown as DatabaseAdapter;
    shared.db = db;
    const hosted = {from:(table:string) => {const chain:{select?:unknown;eq?:unknown;order?:unknown;limit?:unknown;maybeSingle?:unknown}={};for(const method of ['select','eq','order','limit'])chain[method as 'select']=()=>chain;chain.maybeSingle=async()=>({data:table==='upload_history'?history:job,error:null});return chain;}};
    const args = {userId:'fixture-user',tenantId:'fixture-tenant',wingetId:'Vendor.App',latestVersion:'1.2.3'};
    const local = await buildDeploymentConfigFromAdapter(db,args);
    const remote = await buildDeploymentConfigForApp(hosted as never,args);
    expect(remote).toEqual(local);
    expect(local).toMatchObject({status:'ok',deploymentConfig:{detectionRules:rules,psadtConfig:{customDetection:true,detectionRules:rules}}});
  });

  it('keeps administrator rules exact when the update targets a newer version', async () => {
    const rules = [{type:'registry',keyPath:'HKEY_LOCAL_MACHINE\\Vendor',valueName:'Version',detectionType:'version',operator:'greaterThanOrEqual',detectionValue:'1.0.0'}];
    const job = {display_name:'Vendor App',publisher:'Vendor',architecture:'x64',installer_type:'exe',install_command:'app.exe /S',uninstall_command:'app.exe /X',install_scope:'machine',detection_rules:rules,package_config:{psadtConfig:{...DEFAULT_PSADT_CONFIG,customDetection:true,detectionRules:rules}}};
    const db = {uploadHistory:{getByTenantId:vi.fn().mockResolvedValue([{id:'history',packaging_job_id:'job',winget_id:'Vendor.App'}])},jobs:{getById:vi.fn().mockResolvedValue(job)}} as unknown as DatabaseAdapter;
    const built = await buildDeploymentConfigFromAdapter(db,{userId:'fixture-user',tenantId:'fixture-tenant',wingetId:'Vendor.App',latestVersion:'2.0.0'});
    expect(built).toMatchObject({status:'ok',deploymentConfig:{detectionRules:rules}});
  });

  it('points generated version rules at the version being deployed', async () => {
    const rules = [{type:'registry',keyPath:'HKEY_LOCAL_MACHINE\\Vendor',valueName:'Version',detectionType:'version',operator:'equal',detectionValue:'1.0.0'}];
    const job = {display_name:'Vendor App',publisher:'Vendor',architecture:'x64',installer_type:'exe',install_command:'app.exe /S',uninstall_command:'app.exe /X',install_scope:'machine',detection_rules:rules,package_config:{psadtConfig:{...DEFAULT_PSADT_CONFIG}}};
    const db = {uploadHistory:{getByTenantId:vi.fn().mockResolvedValue([{id:'history',packaging_job_id:'job',winget_id:'Vendor.App'}])},jobs:{getById:vi.fn().mockResolvedValue(job)}} as unknown as DatabaseAdapter;
    const built = await buildDeploymentConfigFromAdapter(db,{userId:'fixture-user',tenantId:'fixture-tenant',wingetId:'Vendor.App',latestVersion:'2.0.0'});
    expect(built).toMatchObject({status:'ok',deploymentConfig:{detectionRules:[{...rules[0],detectionValue:'2.0.0'}]}});
  });
});
