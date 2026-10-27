-- Synthetic source schema: no database dump or patient data is used.
CREATE SCHEMA clinical_source;
SET search_path TO clinical_source;

CREATE TABLE cpoe_inpat_record (
  inpat_id bigint PRIMARY KEY, inpat_code text, cur_hospital_code text, is_valid boolean,
  inpat_state_code text, inpat_state_name text, in_time timestamp, out_time timestamp,
  current_dept_code text, out_dept_code text, out_dept_name text, source_inpat_id text, source_inpat_no text,
  sex_code text, sex_name text, age numeric, age_unit text, birth_date timestamp,
  discharge_mode_code text, discharge_situation_code text, oper_time timestamp, etl_time timestamp
);
CREATE TABLE cpoe_diagnose_record (
  id bigint PRIMARY KEY, inpat_id bigint, cur_hospital_code text, diag_type text, diag_type_name text,
  diag_code text, diag_name text, icd_code text, icd_name text, is_main_diag boolean, is_suspected boolean,
  is_deleted boolean, is_current boolean, diag_date timestamp, oper_time timestamp
);
CREATE TABLE cpoe_inpat_order (
  order_id bigint PRIMARY KEY, inpat_id bigint, cur_hospital_code text, cp_exec_id integer, cp_node_id integer,
  cp_source_project_id integer, order_name text, order_type_code text, order_class_code text, order_state_id integer,
  is_deleted boolean, begin_time timestamp, end_time timestamp, input_time timestamp, exec_time timestamp,
  exec_num integer, state_change_reason text, is_out_pat integer, rowversion bigint, drug_code text, drug_name text,
  once_dose numeric, dose_unit_name text, frequency_code text, frequency_name text, usage_code text, usage_name text
);
CREATE TABLE cpoe_inpat_medical_record (
  id bigint PRIMARY KEY, inpat_id bigint, record_name text, folder_code text, template_code text,
  record_date timestamp, record_state_code text, record_state_name text, is_draft boolean,
  sign1_time timestamp, sign2_time timestamp, sign3_time timestamp, oper_time timestamp
);
CREATE TABLE cpoe_inpat_medical_record_content (
  id bigint PRIMARY KEY, record_id bigint, record_text text, file_version text, record_text_md5 text, oper_time timestamp
);
CREATE TABLE cp_clinical_pathway (
  id integer PRIMARY KEY, pathway_code text, pathway_name text, version_no numeric, state_code smallint,
  cur_hospital_code text, dept_code text, dept_name text, days_lower_limit integer, days_upper_limit integer,
  fee_lower_limit numeric, fee_upper_limit numeric, is_deleted boolean, is_branch_path boolean,
  is_treatment_package boolean, oper_time timestamp
);
CREATE TABLE cp_clinical_pathway_dept (
  id integer PRIMARY KEY, clinical_pathway_id integer, dept_code text, dept_name text, cur_hospital_code text
);
CREATE TABLE cp_clinical_pathway_diagnostic_groups (
  id integer PRIMARY KEY, clinical_pathway_id integer, diagnosis_code text, diagnosis_name text,
  copy_id integer, cur_hospital_code text
);
CREATE TABLE cp_clinical_pathway_evaluate (
  id integer PRIMARY KEY, clinical_pathway_id integer, evaluation_criteria text, evaluation_type smallint,
  is_required boolean, basis_kind text, basis_kind_name text, cur_hospital_code text
);
CREATE TABLE cp_clinical_pathway_node (
  id integer PRIMARY KEY, clinical_pathway_id integer, last_node_id integer, node_attribute smallint,
  node_name text, clinical_properties text, days_lower_limit integer, days_upper_limit integer,
  is_exist_branch_path boolean, branch_path_id integer, cur_hospital_code text
);
CREATE TABLE cp_branch_path (
  id integer PRIMARY KEY, node_id integer, cpid integer, clinical_properties text, cur_hospital_code text
);
CREATE TABLE cp_clinical_pathway_item (
  id integer PRIMARY KEY, node_id integer, item_type smallint, item_code text, item_name text,
  item_class_code text, item_class_name text, item_sub_class_code text, item_sub_class_name text,
  order_type_code text, drug_id integer, once_dose numeric, dose_unit text, frequency_code text,
  frequency_name text, usage_code text, usage_name text, usage_type_code text, usage_type_name text,
  days integer, specs text, base_unit_name text, min_unit_name text, pack_unit_name text,
  exec_dept_code text, exec_dept_name text, is_required boolean, is_repeatable boolean,
  is_multiple_choice boolean, is_once_dose_change boolean, is_apply_order boolean, group_code text,
  operation_apply_id integer, template_code text, remark text, group_sign smallint, group_flag text,
  group_sn integer, group_package_flag text, group_package_sn integer, group_sort integer,
  test_is_group boolean, is_self boolean, cur_hospital_code text
);
CREATE TABLE cp_clinical_pathway_item_operation (
  id integer PRIMARY KEY, item_id integer, operation_code text, operation_name text,
  operation_code2 text, cur_hospital_code text
);
CREATE TABLE cp_clinical_pathway_item_dic (
  id integer PRIMARY KEY, cur_hospital_code text, dept_code text, item_type smallint,
  item_code text, item_name text, clinical_pathway_item_name text
);
CREATE TABLE fixture_drug_parameters (
  cur_hospital_code text, drug_code text, base_dose numeric, base_dose1 numeric,
  base_unit_name1 text, skin_test_flag boolean
);
CREATE VIEW v_cpoe_drug AS SELECT cur_hospital_code,drug_code,base_dose,base_dose1,base_unit_name1,skin_test_flag
FROM fixture_drug_parameters;
CREATE TABLE cp_herbal_recipe (
  item_id integer PRIMARY KEY REFERENCES cp_clinical_pathway_item(id), cur_hospital_code text,
  order_name text, order_type_code text, exec_dept_code text, exec_dept_name text,
  drug_count integer, decoct_count integer, usage_code text, usage_name text, usage_code2 text,
  usage_name2 text, frequency_code text, frequency_name text, decoction_code text, decoction_name text,
  rules_treatment_name text, note text, special_usage_code text, special_usage_name text,
  is_decoction boolean, is_prescription boolean, is_out_pat smallint, herb_type_code text,
  decoction_dosage numeric, decoction_times integer, rate_code text, rate_name text
);
CREATE TABLE cp_herbal_recipe_detail (
  id integer PRIMARY KEY, item_id integer REFERENCES cp_herbal_recipe(item_id), sort integer,
  cur_hospital_code text, drug_id integer, drug_code text, drug_name text, order_sub_class_code text,
  order_sub_class_name text, specs text, qty numeric, once_dose numeric, dose_unit_code text,
  dose_unit_name text, dosage_code text, dosage_name text, base_dose numeric, base_unit_code text,
  base_unit_name text, send_unit_code text, send_unit_name text, send_pack_qty numeric,
  usage_code text, usage_name text, usage_code2 text, usage_name2 text, min_unit_code text,
  min_unit_name text, pack_unit_code text, pack_unit_name text, pack_qty numeric, unit_sort smallint,
  note text, herb_type_code text, UNIQUE(item_id,sort)
);
CREATE TABLE cp_clinical_pathway_execution_records (
  id integer PRIMARY KEY, cur_hospital_code text, inpat_id bigint, inpat_code text,
  pathway_id integer, pathway_code text, version_no numeric, pathway_name text, execution_status smallint,
  create_time timestamp, oper_time timestamp, dept_code text, is_deleted boolean,
  is_treatment_package boolean, evaluation_id text
);
CREATE TABLE cp_execution_records_reason (
  id integer PRIMARY KEY, cur_hospital_code text, execution_pathway_id integer, execution_node_id integer,
  execution_item_id integer, reason_type smallint, reason_id integer, other_reason text,
  is_variation boolean, create_time timestamp
);
CREATE TABLE cp_clinical_pathway_item_execution_records (
  id integer PRIMARY KEY, cur_hospital_code text, exec_id integer, execution_node_id integer,
  item_id integer, item_code text, item_name text, item_class_code text, create_time timestamp
);

INSERT INTO cpoe_inpat_record(inpat_id,inpat_code,cur_hospital_code,is_valid,inpat_state_code,in_time,out_time,current_dept_code,out_dept_code) VALUES
  (101,'synthetic-101','h1',true,'6','2025-02-01','2025-02-10','dept1','dept1'),
  (102,'synthetic-102','h1',true,'7','2025-03-01','2025-03-10','dept1','dept1'),
  (103,'synthetic-103','h1',true,'6','2025-04-01','2025-04-10','dept1','dept1'),
  (104,'synthetic-104','h2',true,'6','2025-02-01','2025-02-10','dept1','dept1'),
  (105,'synthetic-105','h1',true,'6','2025-02-01','2025-02-10','dept2','dept2'),
  (106,'synthetic-106','h1',false,'6','2025-02-01','2025-02-10','dept1','dept1'),
  (107,'synthetic-107','h1',true,'6','2023-02-01','2025-02-10','dept1','dept1');
INSERT INTO cpoe_diagnose_record(id,inpat_id,cur_hospital_code,diag_type,diag_code,icd_code,is_main_diag,is_suspected,is_deleted,is_current) VALUES
  (301,101,'h1','10','LOCAL-J18','J18',true,false,false,true),
  (302,101,'h1','10','LOCAL-J18','J18',false,true,NULL,true),
  (303,102,'h1','10','LOCAL-J18','J18',true,false,false,true),
  (304,103,'h1','31','LOCAL-J18','J18',false,false,false,true),
  (305,104,'h2','10','LOCAL-J18','J18',true,false,false,true),
  (306,101,'h1','10','DELETED','J99',true,false,true,false);
INSERT INTO cp_clinical_pathway(id,pathway_code,pathway_name,version_no,state_code,cur_hospital_code,dept_code,is_deleted,is_branch_path) VALUES
  (1,'SYNTHETIC','Synthetic root',1,4,'h1','dept1',NULL,false),
  (2,'SYNTHETIC-BRANCH','Synthetic branch',2,4,'h1','dept1',false,true),
  (3,'OTHER-HOSPITAL','Other hospital',1,4,'h2','dept1',false,true),
  (4,'OTHER-DEPARTMENT','Other department',1,4,'h1','dept2',false,true),
  (5,'SHARED','Shared definition',1,4,'h1','dept2',false,false),
  (6,'ASSIGNED','Assigned definition',1,4,'h1','dept2',false,false);
INSERT INTO cp_clinical_pathway_dept VALUES (1,5,'-1','Shared','h1'),(2,6,'dept1','Assigned','h1');
INSERT INTO cp_clinical_pathway_diagnostic_groups VALUES (1,1,'J18','Synthetic diagnosis',NULL,'h1');
INSERT INTO cp_clinical_pathway_evaluate VALUES (1,1,'Synthetic inclusion criterion',0,true,'fixture','Synthetic','h1');
INSERT INTO cp_clinical_pathway_node(id,clinical_pathway_id,last_node_id,node_attribute,node_name,cur_hospital_code) VALUES
  (20,1,0,0,'First node','h1'),(10,1,20,2,'Second node','h1'),(30,2,0,0,'Branch node','h1'),(40,1,0,0,'Other hospital node','h2');
INSERT INTO cp_branch_path VALUES (1,10,2,'Allowed branch','h1'),(2,10,3,'Other hospital','h1'),
  (3,10,4,'Other department','h1'),(4,30,1,'Cycle','h1');
INSERT INTO cp_clinical_pathway_item(id,node_id,item_type,item_code,item_name,item_class_code,group_sign,group_sort,cur_hospital_code) VALUES
  (40,20,0,'HERB','Synthetic recipe','24',1,1,'h1'),(41,10,0,'ORDER','Synthetic order','1',1,1,'h1'),
  (42,20,0,'OUTSIDE','Other hospital item','1',1,1,'h2');
INSERT INTO cp_clinical_pathway_item_operation VALUES (1,41,'OP-SYNTHETIC','Synthetic operation',NULL,'h1');
INSERT INTO cp_clinical_pathway_item_dic VALUES (1,'h1','dept1|dept2',0,'ORDER','Synthetic dictionary','Synthetic item'),
  (2,'h1','dept10',0,'ORDER','Other department','Other'),(3,'h2','dept1',0,'ORDER','Other hospital','Other');
INSERT INTO fixture_drug_parameters VALUES ('h1','ORDER',0,1.25,'Synthetic unit',false),
  ('h2','ORDER',999,999,'Other hospital unit',true),('h1','OUTSIDE',999,999,'Unreturned item unit',true);
INSERT INTO cp_herbal_recipe(item_id,cur_hospital_code,order_name,drug_count,usage_code,frequency_code,decoction_dosage) VALUES
  (40,'h1','Synthetic recipe',2,'ORAL','DAILY',200.25);
INSERT INTO cp_herbal_recipe_detail(id,item_id,sort,cur_hospital_code,drug_id,drug_code,drug_name,once_dose,dose_unit_name) VALUES
  (42,40,2,'h1',2,'SYNTHETIC-2','Second synthetic ingredient',2.5,'g'),
  (43,40,1,'h1',1,'SYNTHETIC-1','First synthetic ingredient',1.25,'g');
INSERT INTO cp_clinical_pathway_execution_records(id,cur_hospital_code,inpat_id,pathway_id,pathway_code,version_no,execution_status,create_time,dept_code,is_deleted,is_treatment_package,evaluation_id) VALUES
  (201,'h1',101,1,'SYNTHETIC',1,3,'2025-02-02','dept1',false,false,'1,2'),
  (202,'h1',103,1,'SYNTHETIC',1,1,'2025-04-02','dept1',NULL,NULL,NULL),
  (203,'h1',103,2,'SYNTHETIC-BRANCH',2,2,'2025-04-03','dept1',false,false,NULL),
  (204,'h1',103,1,'SYNTHETIC',1,0,'2025-04-04','dept1',false,false,NULL),
  (205,'h1',103,1,'SYNTHETIC',1,4,'2025-04-05','dept1',false,false,NULL),
  (206,'h1',102,1,'SYNTHETIC',1,3,'2025-03-02','dept1',false,true,NULL),
  (207,'h1',101,1,'SYNTHETIC',1,3,'2025-02-02','dept1',true,false,NULL),
  (208,'h2',104,1,'SYNTHETIC',1,3,'2025-02-02','dept1',false,false,NULL);
INSERT INTO cp_execution_records_reason(id,cur_hospital_code,execution_pathway_id,execution_item_id,reason_type,is_variation) VALUES
  (401,'h1',201,501,2,true),(402,'h1',203,NULL,4,NULL),(403,'h1',201,NULL,3,true),(404,'h2',201,NULL,4,true);
INSERT INTO cp_clinical_pathway_item_execution_records(id,cur_hospital_code,exec_id,execution_node_id,item_id) VALUES (601,'h1',201,10,502);
INSERT INTO cpoe_inpat_order(order_id,inpat_id,cur_hospital_code,cp_exec_id,cp_node_id,cp_source_project_id,order_state_id,is_deleted,order_name) VALUES
  (501,101,'h1',NULL,NULL,NULL,2,false,'Synthetic external order'),
  (502,101,'h1',201,10,41,2,false,'Synthetic pathway order'),
  (503,104,'h2',201,10,41,2,false,'Other hospital order');
INSERT INTO cpoe_inpat_medical_record(id,inpat_id,record_name,record_state_code,is_draft) VALUES
  (701,101,'Synthetic multiversion document','signed',false),
  (702,101,'Synthetic missing content','draft',true),
  (703,101,'Synthetic NULL text','draft',true),
  (704,101,'Synthetic empty text','draft',true);
INSERT INTO cpoe_inpat_medical_record_content(id,record_id,record_text,file_version) VALUES
  (801,701,'甲乙丙丁戊','2'),(802,701,'另一个版本文本','10'),(803,703,NULL,'1'),(804,704,'','1');

CREATE ROLE fixture_reader LOGIN PASSWORD 'synthetic-reader-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE fixture_reader SET timezone TO 'UTC';
ALTER ROLE fixture_reader SET default_transaction_read_only TO on;
GRANT USAGE ON SCHEMA clinical_source TO fixture_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA clinical_source TO fixture_reader;

CREATE ROLE fixture_developer LOGIN PASSWORD 'synthetic-developer-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE fixture_developer SET timezone TO 'UTC';
ALTER ROLE fixture_developer SET default_transaction_read_only TO off;
GRANT USAGE ON SCHEMA clinical_source TO fixture_developer;
GRANT SELECT ON ALL TABLES IN SCHEMA clinical_source TO fixture_developer;
GRANT UPDATE ON clinical_source.cpoe_inpat_record TO fixture_developer;
