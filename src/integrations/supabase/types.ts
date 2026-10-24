export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      account_group_rules: {
        Row: {
          created_at: string
          group_name: string
          id: string
          keyword: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          group_name: string
          id?: string
          keyword: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          group_name?: string
          id?: string
          keyword?: string
          updated_at?: string
        }
        Relationships: []
      }
      account_treatment_rules: {
        Row: {
          created_at: string
          id: string
          keyword: string
          note: string | null
          treatment: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          keyword: string
          note?: string | null
          treatment: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          keyword?: string
          note?: string | null
          treatment?: string
          updated_at?: string
        }
        Relationships: []
      }
      accounts: {
        Row: {
          active: boolean
          base_name: string | null
          code: string | null
          created_at: string
          dre_line_id: string | null
          generates_tax_credit: boolean
          group_name: string | null
          id: string
          kind: string
          name: string
          omie_category_code: string | null
          period: string | null
          sort_order: number
          treatment: string
          unit_ids: string[] | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          base_name?: string | null
          code?: string | null
          created_at?: string
          dre_line_id?: string | null
          generates_tax_credit?: boolean
          group_name?: string | null
          id?: string
          kind: string
          name: string
          omie_category_code?: string | null
          period?: string | null
          sort_order?: number
          treatment?: string
          unit_ids?: string[] | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          base_name?: string | null
          code?: string | null
          created_at?: string
          dre_line_id?: string | null
          generates_tax_credit?: boolean
          group_name?: string | null
          id?: string
          kind?: string
          name?: string
          omie_category_code?: string | null
          period?: string | null
          sort_order?: number
          treatment?: string
          unit_ids?: string[] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_dre_line_id_fkey"
            columns: ["dre_line_id"]
            isOneToOne: false
            referencedRelation: "dre_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          changed_by: string | null
          created_at: string
          id: string
          new_data: Json | null
          old_data: Json | null
          row_id: string | null
          table_name: string
        }
        Insert: {
          action: string
          changed_by?: string | null
          created_at?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          row_id?: string | null
          table_name: string
        }
        Update: {
          action?: string
          changed_by?: string | null
          created_at?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          row_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      budget_versions: {
        Row: {
          base_version_id: string | null
          created_at: string
          first_editable_month: number
          id: string
          is_default: boolean
          kind: string
          name: string
          status: string
          updated_at: string
          year: number
        }
        Insert: {
          base_version_id?: string | null
          created_at?: string
          first_editable_month?: number
          id?: string
          is_default?: boolean
          kind?: string
          name: string
          status?: string
          updated_at?: string
          year: number
        }
        Update: {
          base_version_id?: string | null
          created_at?: string
          first_editable_month?: number
          id?: string
          is_default?: boolean
          kind?: string
          name?: string
          status?: string
          updated_at?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "budget_versions_base_version_id_fkey"
            columns: ["base_version_id"]
            isOneToOne: false
            referencedRelation: "budget_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      calc_rules: {
        Row: {
          account_ids: string[] | null
          active: boolean
          base_kind: string
          contract_type_ids: string[] | null
          created_at: string
          exclude_revenue_type_ids: string[] | null
          id: string
          name: string
          parameter_definition_id: string
          payroll_group: string | null
          revenue_type_ids: string[] | null
          sort_order: number
          target_dre_line_id: string
          updated_at: string
        }
        Insert: {
          account_ids?: string[] | null
          active?: boolean
          base_kind: string
          contract_type_ids?: string[] | null
          created_at?: string
          exclude_revenue_type_ids?: string[] | null
          id?: string
          name: string
          parameter_definition_id: string
          payroll_group?: string | null
          revenue_type_ids?: string[] | null
          sort_order?: number
          target_dre_line_id: string
          updated_at?: string
        }
        Update: {
          account_ids?: string[] | null
          active?: boolean
          base_kind?: string
          contract_type_ids?: string[] | null
          created_at?: string
          exclude_revenue_type_ids?: string[] | null
          id?: string
          name?: string
          parameter_definition_id?: string
          payroll_group?: string | null
          revenue_type_ids?: string[] | null
          sort_order?: number
          target_dre_line_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calc_rules_parameter_definition_id_fkey"
            columns: ["parameter_definition_id"]
            isOneToOne: false
            referencedRelation: "parameter_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calc_rules_target_dre_line_id_fkey"
            columns: ["target_dre_line_id"]
            isOneToOne: false
            referencedRelation: "dre_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          active: boolean
          created_at: string
          document: string | null
          id: string
          name: string
          omie_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          document?: string | null
          id?: string
          name: string
          omie_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          document?: string | null
          id?: string
          name?: string
          omie_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      contract_types: {
        Row: {
          account_id: string
          active: boolean
          created_at: string
          id: string
          name: string
          role_keywords: string[] | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          account_id: string
          active?: boolean
          created_at?: string
          id?: string
          name: string
          role_keywords?: string[] | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          account_id?: string
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          role_keywords?: string[] | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_types_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      dre_lines: {
        Row: {
          active: boolean
          code: string
          created_at: string
          denominator_line_id: string | null
          id: string
          kind: string
          name: string
          numerator_line_id: string | null
          sign: number
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          denominator_line_id?: string | null
          id?: string
          kind: string
          name: string
          numerator_line_id?: string | null
          sign?: number
          sort_order: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          denominator_line_id?: string | null
          id?: string
          kind?: string
          name?: string
          numerator_line_id?: string | null
          sign?: number
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dre_lines_denominator_line_id_fkey"
            columns: ["denominator_line_id"]
            isOneToOne: false
            referencedRelation: "dre_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dre_lines_numerator_line_id_fkey"
            columns: ["numerator_line_id"]
            isOneToOne: false
            referencedRelation: "dre_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          month: number
          name: string
          product_id: string | null
          unit_id: string
          updated_at: string
          version_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          month: number
          name: string
          product_id?: string | null
          unit_id: string
          updated_at?: string
          version_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          month?: number
          name?: string
          product_id?: string | null
          unit_id?: string
          updated_at?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "budget_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      parameter_definitions: {
        Row: {
          active: boolean
          allowed_scopes: string[]
          created_at: string
          description: string | null
          id: string
          key: string
          label: string
          max_value: number | null
          min_value: number | null
          sort_order: number
          updated_at: string
          value_type: string
        }
        Insert: {
          active?: boolean
          allowed_scopes?: string[]
          created_at?: string
          description?: string | null
          id?: string
          key: string
          label: string
          max_value?: number | null
          min_value?: number | null
          sort_order?: number
          updated_at?: string
          value_type?: string
        }
        Update: {
          active?: boolean
          allowed_scopes?: string[]
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          label?: string
          max_value?: number | null
          min_value?: number | null
          sort_order?: number
          updated_at?: string
          value_type?: string
        }
        Relationships: []
      }
      parameter_values: {
        Row: {
          contract_type_id: string | null
          created_at: string
          created_by: string | null
          definition_id: string
          id: string
          note: string | null
          product_id: string | null
          revenue_type_id: string | null
          unit_id: string | null
          valid_from: string
          value: number
        }
        Insert: {
          contract_type_id?: string | null
          created_at?: string
          created_by?: string | null
          definition_id: string
          id?: string
          note?: string | null
          product_id?: string | null
          revenue_type_id?: string | null
          unit_id?: string | null
          valid_from: string
          value: number
        }
        Update: {
          contract_type_id?: string | null
          created_at?: string
          created_by?: string | null
          definition_id?: string
          id?: string
          note?: string | null
          product_id?: string | null
          revenue_type_id?: string | null
          unit_id?: string | null
          valid_from?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "parameter_values_contract_type_id_fkey"
            columns: ["contract_type_id"]
            isOneToOne: false
            referencedRelation: "contract_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parameter_values_definition_id_fkey"
            columns: ["definition_id"]
            isOneToOne: false
            referencedRelation: "parameter_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parameter_values_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parameter_values_revenue_type_id_fkey"
            columns: ["revenue_type_id"]
            isOneToOne: false
            referencedRelation: "revenue_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parameter_values_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_tax_brackets: {
        Row: {
          created_at: string
          deduction: number
          id: string
          lower_bound: number
          rate: number
          table_key: string
          updated_at: string
          upper_bound: number | null
          valid_from: string
        }
        Insert: {
          created_at?: string
          deduction?: number
          id?: string
          lower_bound: number
          rate: number
          table_key: string
          updated_at?: string
          upper_bound?: number | null
          valid_from: string
        }
        Update: {
          created_at?: string
          deduction?: number
          id?: string
          lower_bound?: number
          rate?: number
          table_key?: string
          updated_at?: string
          upper_bound?: number | null
          valid_from?: string
        }
        Relationships: []
      }
      payroll_tax_constants: {
        Row: {
          created_at: string
          id: string
          key: string
          label: string
          updated_at: string
          valid_from: string
          value: number
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          label: string
          updated_at?: string
          valid_from: string
          value: number
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          label?: string
          updated_at?: string
          valid_from?: string
          value?: number
        }
        Relationships: []
      }
      people: {
        Row: {
          base_salary: number
          contract_type_id: string
          created_at: string
          dependents: number
          end_month: number | null
          external_id: string | null
          hire_date: string | null
          id: string
          name: string
          role_title: string | null
          start_month: number | null
          unit_id: string
          updated_at: string
          version_id: string
        }
        Insert: {
          base_salary?: number
          contract_type_id: string
          created_at?: string
          dependents?: number
          end_month?: number | null
          external_id?: string | null
          hire_date?: string | null
          id?: string
          name: string
          role_title?: string | null
          start_month?: number | null
          unit_id: string
          updated_at?: string
          version_id: string
        }
        Update: {
          base_salary?: number
          contract_type_id?: string
          created_at?: string
          dependents?: number
          end_month?: number | null
          external_id?: string | null
          hire_date?: string | null
          id?: string
          name?: string
          role_title?: string | null
          start_month?: number | null
          unit_id?: string
          updated_at?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "people_contract_type_id_fkey"
            columns: ["contract_type_id"]
            isOneToOne: false
            referencedRelation: "contract_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "people_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "people_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "budget_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_lines: {
        Row: {
          account_id: string
          client_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          event_id: string | null
          id: string
          origin: string
          person_id: string | null
          product_id: string | null
          revenue_origin: string | null
          revenue_type_id: string | null
          sort_order: number
          unit_id: string
          updated_at: string
          version_id: string
        }
        Insert: {
          account_id: string
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          event_id?: string | null
          id?: string
          origin?: string
          person_id?: string | null
          product_id?: string | null
          revenue_origin?: string | null
          revenue_type_id?: string | null
          sort_order?: number
          unit_id: string
          updated_at?: string
          version_id: string
        }
        Update: {
          account_id?: string
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          event_id?: string | null
          id?: string
          origin?: string
          person_id?: string | null
          product_id?: string | null
          revenue_origin?: string | null
          revenue_type_id?: string | null
          sort_order?: number
          unit_id?: string
          updated_at?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_lines_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_lines_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_lines_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_lines_revenue_type_id_fkey"
            columns: ["revenue_type_id"]
            isOneToOne: false
            referencedRelation: "revenue_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_lines_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_lines_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "budget_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_values: {
        Row: {
          amount: number
          id: string
          line_id: string
          month: number
          updated_at: string
        }
        Insert: {
          amount?: number
          id?: string
          line_id: string
          month: number
          updated_at?: string
        }
        Update: {
          amount?: number
          id?: string
          line_id?: string
          month?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_values_line_id_fkey"
            columns: ["line_id"]
            isOneToOne: false
            referencedRelation: "plan_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          active: boolean
          cost_account_id: string | null
          cost_per_participant: number | null
          created_at: string
          default_seats: number | null
          duration_months: number | null
          fixed_cost: number | null
          id: string
          kind: string
          name: string
          omie_code: string | null
          price: number | null
          price_model: string
          revenue_account_id: string | null
          revenue_type_id: string | null
          unit_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          cost_account_id?: string | null
          cost_per_participant?: number | null
          created_at?: string
          default_seats?: number | null
          duration_months?: number | null
          fixed_cost?: number | null
          id?: string
          kind?: string
          name: string
          omie_code?: string | null
          price?: number | null
          price_model?: string
          revenue_account_id?: string | null
          revenue_type_id?: string | null
          unit_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          cost_account_id?: string | null
          cost_per_participant?: number | null
          created_at?: string
          default_seats?: number | null
          duration_months?: number | null
          fixed_cost?: number | null
          id?: string
          kind?: string
          name?: string
          omie_code?: string | null
          price?: number | null
          price_model?: string
          revenue_account_id?: string | null
          revenue_type_id?: string | null
          unit_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_cost_account_id_fkey"
            columns: ["cost_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_revenue_account_id_fkey"
            columns: ["revenue_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_revenue_type_id_fkey"
            columns: ["revenue_type_id"]
            isOneToOne: false
            referencedRelation: "revenue_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      revenue_targets: {
        Row: {
          amount: number
          month: number
          scenario_id: string
          unit_id: string
        }
        Insert: {
          amount: number
          month: number
          scenario_id: string
          unit_id: string
        }
        Update: {
          amount?: number
          month?: number
          scenario_id?: string
          unit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "revenue_targets_scenario_id_fkey"
            columns: ["scenario_id"]
            isOneToOne: false
            referencedRelation: "scenarios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "revenue_targets_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      revenue_types: {
        Row: {
          active: boolean
          created_at: string
          id: string
          max_months: number | null
          name: string
          recurrence_months: number | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          max_months?: number | null
          name: string
          recurrence_months?: number | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          max_months?: number | null
          name?: string
          recurrence_months?: number | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      salary_changes: {
        Row: {
          created_at: string
          id: string
          month: number
          new_salary: number
          person_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          month: number
          new_salary: number
          person_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          month?: number
          new_salary?: number
          person_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "salary_changes_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      scenario_targets: {
        Row: {
          computed_at: string | null
          created_at: string
          feasible: boolean | null
          financial_revenue: number | null
          financial_variable_pct: number
          fixed_costs: number | null
          id: string
          published_at: string | null
          required_revenue: number | null
          scenario_id: string
          target_amount: number | null
          target_kind: string
          target_margin: number | null
          target_value: number
          updated_at: string
          variable_pct: number | null
        }
        Insert: {
          computed_at?: string | null
          created_at?: string
          feasible?: boolean | null
          financial_revenue?: number | null
          financial_variable_pct?: number
          fixed_costs?: number | null
          id?: string
          published_at?: string | null
          required_revenue?: number | null
          scenario_id: string
          target_amount?: number | null
          target_kind?: string
          target_margin?: number | null
          target_value?: number
          updated_at?: string
          variable_pct?: number | null
        }
        Update: {
          computed_at?: string | null
          created_at?: string
          feasible?: boolean | null
          financial_revenue?: number | null
          financial_variable_pct?: number
          fixed_costs?: number | null
          id?: string
          published_at?: string | null
          required_revenue?: number | null
          scenario_id?: string
          target_amount?: number | null
          target_kind?: string
          target_margin?: number | null
          target_value?: number
          updated_at?: string
          variable_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "scenario_targets_scenario_id_fkey"
            columns: ["scenario_id"]
            isOneToOne: true
            referencedRelation: "scenarios"
            referencedColumns: ["id"]
          },
        ]
      }
      scenarios: {
        Row: {
          applies_to_payroll: boolean
          created_at: string
          expense_variation: number
          id: string
          is_official: boolean
          name: string
          revenue_variation: number
          sort_order: number
          updated_at: string
          version_id: string
        }
        Insert: {
          applies_to_payroll?: boolean
          created_at?: string
          expense_variation?: number
          id?: string
          is_official?: boolean
          name: string
          revenue_variation?: number
          sort_order?: number
          updated_at?: string
          version_id: string
        }
        Update: {
          applies_to_payroll?: boolean
          created_at?: string
          expense_variation?: number
          id?: string
          is_official?: boolean
          name?: string
          revenue_variation?: number
          sort_order?: number
          updated_at?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scenarios_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "budget_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      target_month_weights: {
        Row: {
          id: string
          month: number
          scenario_id: string
          unit_id: string | null
          weight: number
        }
        Insert: {
          id?: string
          month: number
          scenario_id: string
          unit_id?: string | null
          weight: number
        }
        Update: {
          id?: string
          month?: number
          scenario_id?: string
          unit_id?: string | null
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "target_month_weights_scenario_id_fkey"
            columns: ["scenario_id"]
            isOneToOne: false
            referencedRelation: "scenarios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "target_month_weights_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      target_unit_shares: {
        Row: {
          id: string
          scenario_id: string
          share: number
          unit_id: string
          variable_pct_override: number | null
        }
        Insert: {
          id?: string
          scenario_id: string
          share: number
          unit_id: string
          variable_pct_override?: number | null
        }
        Update: {
          id?: string
          scenario_id?: string
          share?: number
          unit_id?: string
          variable_pct_override?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "target_unit_shares_scenario_id_fkey"
            columns: ["scenario_id"]
            isOneToOne: false
            referencedRelation: "scenarios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "target_unit_shares_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      unit_submissions: {
        Row: {
          comment: string | null
          id: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_at: string | null
          submitted_by: string | null
          unit_id: string
          updated_at: string
          version_id: string
        }
        Insert: {
          comment?: string | null
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
          unit_id: string
          updated_at?: string
          version_id: string
        }
        Update: {
          comment?: string | null
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
          unit_id?: string
          updated_at?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "unit_submissions_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unit_submissions_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "budget_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      units: {
        Row: {
          active: boolean
          created_at: string
          id: string
          kind: string
          name: string
          name_keywords: string[] | null
          omie_department_code: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          kind?: string
          name: string
          name_keywords?: string[] | null
          omie_department_code?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          kind?: string
          name?: string
          name_keywords?: string[] | null
          omie_department_code?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_units: {
        Row: {
          id: string
          unit_id: string
          user_id: string
        }
        Insert: {
          id?: string
          unit_id: string
          user_id: string
        }
        Update: {
          id?: string
          unit_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_units_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      account_kind: { Args: { _account_id: string }; Returns: string }
      accounts_in_use: { Args: never; Returns: string[] }
      assert_editable: {
        Args: { _month: number; _unit_id: string; _version_id: string }
        Returns: undefined
      }
      can_write_line: {
        Args: { _line_id: string; _user_id: string }
        Returns: boolean
      }
      can_write_unit: {
        Args: { _unit_id: string; _user_id: string }
        Returns: boolean
      }
      compute_targets: {
        Args: { _scenario_id: string }
        Returns: {
          computed_at: string | null
          created_at: string
          feasible: boolean | null
          financial_revenue: number | null
          financial_variable_pct: number
          fixed_costs: number | null
          id: string
          published_at: string | null
          required_revenue: number | null
          scenario_id: string
          target_amount: number | null
          target_kind: string
          target_margin: number | null
          target_value: number
          updated_at: string
          variable_pct: number | null
        }
        SetofOptions: {
          from: "*"
          to: "scenario_targets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      copy_version: {
        Args: {
          _kind?: string
          _name: string
          _source_id: string
          _year: number
        }
        Returns: string
      }
      dre_report: {
        Args: {
          _scenario_id: string
          _unit_ids?: string[]
          _version_id: string
        }
        Returns: {
          amount: number
          dre_line_id: string
          month: number
        }[]
      }
      dre_unit_values: {
        Args: {
          _scenario_id: string
          _unit_ids?: string[]
          _version_id: string
        }
        Returns: {
          amount: number
          dre_line_id: string
          month: number
          unit_id: string
        }[]
      }
      has_any_role: {
        Args: {
          _roles: Database["public"]["Enums"]["app_role"][]
          _user_id: string
        }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_unit: {
        Args: { _unit_id: string; _user_id: string }
        Returns: boolean
      }
      import_people: {
        Args: { _overwrite?: boolean; _rows: Json; _version_id: string }
        Returns: Json
      }
      inss_empregado: {
        Args: { _gross: number; _ref: string }
        Returns: number
      }
      irrf: {
        Args: {
          _dependents: number
          _gross: number
          _inss: number
          _ref: string
        }
        Returns: number
      }
      launch_event: {
        Args: {
          _lines?: Json
          _month: number
          _name: string
          _product_id: string
          _unit_id: string
          _version_id: string
        }
        Returns: string
      }
      launch_line: {
        Args: {
          _account_id: string
          _client_id: string
          _description: string
          _event_id?: string
          _product_id: string
          _revenue_origin?: string
          _revenue_type_id: string
          _unit_id: string
          _values?: Json
          _version_id: string
        }
        Returns: string
      }
      param_value: {
        Args: {
          _contract_type_id: string
          _definition_id: string
          _product_id: string
          _ref: string
          _revenue_type_id: string
          _unit_id: string
        }
        Returns: number
      }
      payroll_detail: {
        Args: {
          _scenario_id?: string
          _unit_ids?: string[]
          _version_id: string
        }
        Returns: {
          amount: number
          grupo: string
          item: string
          month: number
          person_id: string
          unit_id: string
        }[]
      }
      plan_base_rows: {
        Args: {
          _scenario_id: string
          _unit_ids?: string[]
          _version_id: string
        }
        Returns: {
          account_id: string
          amount: number
          contract_type_id: string
          dre_line_id: string
          month: number
          product_id: string
          revenue_type_id: string
          row_kind: string
          unit_id: string
        }[]
      }
      plan_split: {
        Args: { _scenario_id: string; _version_id: string }
        Returns: {
          amount: number
          bucket: string
          month: number
          unit_id: string
        }[]
      }
      publish_targets: {
        Args: { _publish?: boolean; _scenario_id: string }
        Returns: {
          computed_at: string | null
          created_at: string
          feasible: boolean | null
          financial_revenue: number | null
          financial_variable_pct: number
          fixed_costs: number | null
          id: string
          published_at: string | null
          required_revenue: number | null
          scenario_id: string
          target_amount: number | null
          target_kind: string
          target_margin: number | null
          target_value: number
          updated_at: string
          variable_pct: number | null
        }
        SetofOptions: {
          from: "*"
          to: "scenario_targets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      seed_person_line: {
        Args: { _person_id: string; _reset?: boolean }
        Returns: string
      }
      set_official_scenario: {
        Args: { _scenario_id: string }
        Returns: undefined
      }
      set_unit_status: {
        Args: {
          _comment?: string
          _status: string
          _unit_id: string
          _version_id: string
        }
        Returns: undefined
      }
      target_gap: {
        Args: { _scenario_id: string }
        Returns: {
          expenses: number
          gap: number
          payroll: number
          result: number
          revenue: number
          target_amount: number
          variable_costs: number
        }[]
      }
      target_vs_plan: {
        Args: {
          _scenario_id: string
          _unit_ids?: string[]
          _version_id: string
        }
        Returns: {
          carteira: number
          month: number
          nova: number
          renovacao: number
          sem_origem: number
          target: number
          unit_id: string
        }[]
      }
      target_weights: {
        Args: { _scenario_id: string; _unit_id: string }
        Returns: {
          month: number
          weight: number
        }[]
      }
      targets_published: { Args: { _scenario_id: string }; Returns: boolean }
      tax_bracket: {
        Args: { _base: number; _ref: string; _table: string }
        Returns: {
          ceiling: number
          deduction: number
          rate: number
        }[]
      }
      tax_constant: { Args: { _key: string; _ref: string }; Returns: number }
      variable_rate_parts: {
        Args: { _ref: string; _unit_id: string }
        Returns: {
          included: boolean
          rate: number
          rule_id: string
          rule_name: string
        }[]
      }
    }
    Enums: {
      app_role: "financeiro" | "vp" | "ceo" | "lider"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["financeiro", "vp", "ceo", "lider"],
    },
  },
} as const

