package com.ptpmhdv.merchantservice.dto;

import lombok.Data;

@Data
public class UpdateMerchantRequest {
    private String businessName;
    private String taxId;
    private String bankAccount;
}
